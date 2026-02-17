import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { createOpencodeClient } from '@opencode-ai/sdk';

const app = express();
const TARGET_PORT = 4097;
const RESPONSE_STATE_TTL_MS = 30 * 60 * 1000;
const responseState = new Map();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

setInterval(() => {
    const now = Date.now();
    for (const [id, state] of responseState.entries()) {
        if (state.expiresAt <= now) {
            responseState.delete(id);
        }
    }
}, 60 * 1000).unref();

/**
 * Downloads an image and returns it as a data URI.
 * If the input is already a data URI, it returns it directly.
 * 
 * @param {string} url The image URL or data URI
 * @returns {Promise<string>} The image as a data URI
 */
async function getImageDataUri(url) {
    if (url.startsWith('data:')) {
        return url;
    }
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'] || 'image/jpeg';
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch (error) {
        console.error(`Failed to fetch image from ${url}:`, error.message);
        throw new Error(`Failed to fetch image: ${url}`);
    }
}

/**
 * Creates and returns an OpenCode SDK client configured with authentication.
 * 
 * @returns {object} The OpenCode SDK client
 */
function getClient() {
    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
    const baseUrl = `http://127.0.0.1:${TARGET_PORT}`;
    const headers = {};
    
    if (serverPassword) {
        headers['Authorization'] = 'Basic ' + Buffer.from(`opencode:${serverPassword}`).toString('base64');
    }

    return createOpencodeClient({ baseUrl, headers });
}

function parseModel(model) {
    if (model && model.includes('/')) {
        const [providerId, modelId] = model.split('/');
        return { providerId, modelId };
    }

    return { providerId: 'opencode', modelId: 'big-pickle' };
}

async function buildPromptPartsAndSystem(messages) {
    const allParts = [];
    let fullPromptText = '';
    let systemPrompt = '';

    for (const m of messages) {
        if (m.role === 'system') {
            if (typeof m.content === 'string') {
                systemPrompt += `${m.content}\n`;
            } else if (Array.isArray(m.content)) {
                systemPrompt += `${m.content.map((c) => c.text || '').join('\n')}\n`;
            }
            continue;
        }

        const role = m.role === 'assistant' ? 'Assistant' : 'User';

        if (typeof m.content === 'string') {
            allParts.push({ type: 'text', text: m.content });
            fullPromptText += `${role}: ${m.content}\n\n`;
            continue;
        }

        if (!Array.isArray(m.content)) {
            continue;
        }

        for (const part of m.content) {
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
                const text = part.text || '';
                allParts.push({ type: 'text', text });
                fullPromptText += `${role}: ${text}\n\n`;
            } else if (part.type === 'image_url' || part.type === 'input_image') {
                const url =
                    typeof part.image_url === 'string'
                        ? part.image_url
                        : part.image_url?.url || part.url;

                if (!url) {
                    continue;
                }

                try {
                    const dataUri = await getImageDataUri(url);
                    const mime = dataUri.split(';')[0].split(':')[1];
                    allParts.push({
                        type: 'file',
                        mime,
                        url: dataUri,
                        filename: 'image'
                    });
                    fullPromptText += `${role}: [Image attached]\n\n`;
                } catch (e) {
                    console.warn('Skipping image due to error:', e.message);
                }
            }
        }
    }

    return {
        allParts,
        fullPromptText: fullPromptText.trim(),
        systemPrompt: systemPrompt.trim()
    };
}

function normalizeResponsesInputToMessages({ input, instructions }) {
    const messages = [];

    if (instructions && typeof instructions === 'string') {
        messages.push({ role: 'system', content: instructions });
    }

    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
        return messages;
    }

    if (input && typeof input === 'object' && !Array.isArray(input) && input.role && input.content !== undefined) {
        messages.push({ role: input.role, content: input.content });
        return messages;
    }

    if (!Array.isArray(input)) {
        return messages;
    }

    for (const item of input) {
        if (typeof item === 'string') {
            messages.push({ role: 'user', content: item });
            continue;
        }

        if (!item || typeof item !== 'object') {
            continue;
        }

        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: item.content || '' });
            continue;
        }

        if (item.type === 'input_text') {
            messages.push({
                role: 'user',
                content: [{ type: 'input_text', text: item.text || '' }]
            });
            continue;
        }

        if (item.type === 'input_image') {
            messages.push({
                role: 'user',
                content: [{ type: 'input_image', image_url: item.image_url || item.url || '' }]
            });
            continue;
        }

        if (item.role && item.content !== undefined) {
            messages.push({ role: item.role, content: item.content });
        }
    }

    return messages;
}

function storeResponseState(responseId, state) {
    responseState.set(responseId, {
        ...state,
        expiresAt: Date.now() + RESPONSE_STATE_TTL_MS
    });
}

function getResponseState(responseId) {
    const state = responseState.get(responseId);
    if (!state) {
        return null;
    }

    if (state.expiresAt <= Date.now()) {
        responseState.delete(responseId);
        return null;
    }

    return state;
}

function buildResponsesOutputText(content, reasoningContent) {
    if (!reasoningContent) {
        return content;
    }

    return `<think>\n${reasoningContent}\n</think>\n\n${content}`;
}

function buildResponsesUsage(promptText, content, reasoningContent) {
    const inputTokens = Math.ceil(promptText.length / 4);
    const outputTokens = Math.ceil((content.length + reasoningContent.length) / 4);
    const reasoningTokens = Math.ceil(reasoningContent.length / 4);

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        output_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

function sendResponseSseEvent(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createId(prefix) {
    return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function normalizeToolChoice(toolChoice) {
    if (toolChoice === undefined || toolChoice === null) {
        return { mode: 'auto' };
    }

    if (typeof toolChoice === 'string') {
        if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
            return { mode: toolChoice };
        }
        return { mode: 'invalid', reason: 'Invalid tool_choice string value' };
    }

    if (toolChoice.type === 'function' && toolChoice.function?.name) {
        return { mode: 'required', name: toolChoice.function.name };
    }

    return { mode: 'invalid', reason: 'Invalid tool_choice object value' };
}

function normalizeTools(tools) {
    if (tools === undefined || tools === null) {
        return { tools: [] };
    }

    if (!Array.isArray(tools)) {
        return {
            tools: [],
            error: 'tools must be an array when provided'
        };
    }

    const normalized = [];
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') {
            continue;
        }

        if (tool.type === 'function') {
            const functionDef = tool.function && typeof tool.function === 'object'
                ? tool.function
                : tool;
            const functionName = typeof functionDef.name === 'string' ? functionDef.name.trim() : '';

            if (!functionName) {
                return {
                    tools: [],
                    error: 'Function tools must include a name'
                };
            }

            normalized.push({
                name: functionName,
                description: functionDef.description || '',
                parameters: functionDef.parameters || functionDef.input_schema || { type: 'object', properties: {} }
            });
            continue;
        }

        if (tool.type === 'web_search' || tool.type === 'file_search' || tool.type === 'code_interpreter') {
            return {
                tools: [],
                error: `Unsupported built-in tool type: ${tool.type}`
            };
        }

        return {
            tools: [],
            error: `Unsupported tool type: ${tool.type || 'unknown'}`
        };
    }

    return { tools: normalized };
}

function buildToolSystemInstruction(tools, toolChoice, parallelToolCalls) {
    if (!tools.length) {
        return '';
    }

    const toolList = tools.map((tool) => {
        return `- ${tool.name}: ${tool.description || 'No description'}; parameters schema: ${JSON.stringify(tool.parameters)}`;
    }).join('\n');

    let policy = 'Use tools only when needed.';
    if (toolChoice.mode === 'none') {
        policy = 'Do not call tools. Respond normally.';
    } else if (toolChoice.mode === 'required' && toolChoice.name) {
        policy = `You must call tool \"${toolChoice.name}\".`;
    } else if (toolChoice.mode === 'required') {
        policy = 'You must call at least one tool.';
    }

    const parallelPolicy = parallelToolCalls ? 'Parallel calls are allowed.' : 'Return at most one tool call.';

    return [
        'TOOLS AVAILABLE:',
        toolList,
        policy,
        parallelPolicy,
        'If you decide to call a tool, respond with ONLY valid JSON in exactly this shape:',
        '{"tool_calls":[{"name":"tool_name","arguments":{}}]}',
        'If no tool call is needed, respond with normal assistant text.'
    ].join('\n');
}

function extractToolCallsFromText(text) {
    if (!text || typeof text !== 'string') {
        return { toolCalls: [], malformed: false };
    }

    const trimmed = text.trim();
    const candidates = [trimmed];
    const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        candidates.push(fenced[1].trim());
    }

    const mentionsToolCalls = /"tool_calls"|"tool_call"/i.test(text);
    const maybeJson = mentionsToolCalls || /^\s*[\[{]/.test(trimmed) || Boolean(fenced?.[1]);
    let malformed = false;

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        let parsed;
        try {
            parsed = JSON.parse(candidate);
        } catch (error) {
            malformed = malformed || mentionsToolCalls;
            continue;
        }

        const hasToolCallField = Object.prototype.hasOwnProperty.call(parsed || {}, 'tool_calls')
            || Object.prototype.hasOwnProperty.call(parsed || {}, 'tool_call');

        const rawCalls = Array.isArray(parsed?.tool_calls)
            ? parsed.tool_calls
            : parsed?.tool_call
                ? [parsed.tool_call]
                : [];

        if (hasToolCallField && !rawCalls.length) {
            malformed = true;
            continue;
        }

        if (!rawCalls.length) {
            continue;
        }

        const normalized = [];
        let invalidCall = false;

        for (const call of rawCalls) {
            if (!call || typeof call !== 'object' || typeof call.name !== 'string' || !call.name.trim()) {
                invalidCall = true;
                break;
            }

            let argsObj = call.arguments;
            if (typeof argsObj === 'string') {
                try {
                    argsObj = JSON.parse(argsObj);
                } catch (error) {
                    invalidCall = true;
                    break;
                }
            }

            if (!argsObj || typeof argsObj !== 'object' || Array.isArray(argsObj)) {
                invalidCall = true;
                break;
            }

            normalized.push({
                call_id: typeof call.call_id === 'string' && call.call_id.trim() ? call.call_id : createId('call'),
                name: call.name,
                arguments: JSON.stringify(argsObj)
            });
        }

        if (invalidCall) {
            malformed = true;
            continue;
        }

        if (normalized.length) {
            return { toolCalls: normalized, malformed: false };
        }
    }

    return { toolCalls: [], malformed: malformed && maybeJson };
}

function extractFunctionCallOutputs(input) {
    if (!Array.isArray(input)) {
        return [];
    }

    return input.filter((item) => item?.type === 'function_call_output' && item.call_id);
}

function buildFunctionCallOutputItems(toolCalls, pendingByCallId = new Map()) {
    return toolCalls.map((toolCall) => {
        const pending = pendingByCallId.get(toolCall.call_id);
        const itemId = pending?.item_id || createId('fc');
        return {
            id: itemId,
            type: 'function_call',
            call_id: toolCall.call_id,
            name: toolCall.name,
            arguments: toolCall.arguments,
            status: 'completed'
        };
    });
}

function resolveFunctionCallOutputTargets(functionCallOutputs, explicitPreviousResponseId, explicitPreviousState) {
    if (functionCallOutputs.length === 0) {
        return {
            continuationState: explicitPreviousState || null,
            ownershipByCallId: new Map()
        };
    }

    if (explicitPreviousResponseId) {
        if (!explicitPreviousState) {
            return {
                error: {
                    message: 'function_call_output requires a valid previous_response_id',
                    type: 'invalid_request_error'
                }
            };
        }

        const ownershipByCallId = new Map(
            (explicitPreviousState.pendingToolCalls || []).map((call) => [
                call.call_id,
                { responseId: explicitPreviousResponseId, state: explicitPreviousState, call }
            ])
        );

        return {
            continuationState: explicitPreviousState,
            ownershipByCallId
        };
    }

    const matchedResponsesByCallId = new Map();
    const matchedResponseStates = [];

    for (const outputItem of functionCallOutputs) {
        const callMatches = [];

        for (const [responseId] of responseState.entries()) {
            const state = getResponseState(responseId);
            if (!state) {
                continue;
            }

            const hasCall = (state.pendingToolCalls || []).some((call) => call.call_id === outputItem.call_id);
            if (hasCall) {
                callMatches.push(responseId);
            }
        }

        if (callMatches.length === 0) {
            return {
                error: {
                    message: `Unknown function_call_output call_id: ${outputItem.call_id}`,
                    type: 'invalid_request_error'
                }
            };
        }

        if (callMatches.length > 1) {
            return {
                error: {
                    message: `Ambiguous function_call_output call_id: ${outputItem.call_id}`,
                    type: 'invalid_request_error'
                }
            };
        }

        const responseId = callMatches[0];
        const state = getResponseState(responseId);
        if (!state) {
            return {
                error: {
                    message: 'Invalid or expired previous_response_id inferred from function_call_output',
                    type: 'invalid_request_error'
                }
            };
        }

        const call = (state.pendingToolCalls || []).find((pendingCall) => pendingCall.call_id === outputItem.call_id);
        matchedResponsesByCallId.set(outputItem.call_id, { responseId, state, call });
        matchedResponseStates.push({ responseId, state });
    }

    const sessionIds = new Set(matchedResponseStates.map((entry) => entry.state.sessionId));
    const modelIds = new Set(matchedResponseStates.map((entry) => entry.state.model));
    if (sessionIds.size !== 1 || modelIds.size !== 1) {
        return {
            error: {
                message: 'function_call_output items must target a single continuation context',
                type: 'invalid_request_error'
            }
        };
    }

    const continuationState = {
        sessionId: matchedResponseStates[0].state.sessionId,
        model: matchedResponseStates[0].state.model,
        pendingToolCalls: [...matchedResponsesByCallId.values()].map((entry) => entry.call)
    };

    return {
        continuationState,
        ownershipByCallId: matchedResponsesByCallId
    };
}

function validateFunctionCallOutputs(functionCallOutputs, ownershipByCallId) {
    if (functionCallOutputs.length === 0) {
        return { validOutputs: [] };
    }

    const seen = new Set();
    const validOutputs = [];

    for (const outputItem of functionCallOutputs) {
        if (seen.has(outputItem.call_id)) {
            return {
                error: {
                    message: `Duplicate function_call_output call_id in request: ${outputItem.call_id}`,
                    type: 'invalid_request_error'
                }
            };
        }
        seen.add(outputItem.call_id);

        const ownership = ownershipByCallId.get(outputItem.call_id);
        if (!ownership?.call) {
            return {
                error: {
                    message: `Unknown function_call_output call_id: ${outputItem.call_id}`,
                    type: 'invalid_request_error'
                }
            };
        }

        if (ownership.call.status === 'completed') {
            return {
                error: {
                    message: `function_call_output already submitted for call_id: ${outputItem.call_id}`,
                    type: 'invalid_request_error'
                }
            };
        }

        validOutputs.push({
            output: outputItem,
            call: ownership.call,
            ownerResponseId: ownership.responseId
        });
    }

    return { validOutputs };
}

function toToolResultString(output) {
    if (typeof output === 'string') {
        return output;
    }

    try {
        return JSON.stringify(output);
    } catch (error) {
        return String(output);
    }
}

// Auth Middleware
app.use((req, res, next) => {
    // Permite health check sem auth
    if (req.path === '/health') return next();

    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
    
    if (serverPassword) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                error: { message: 'Missing or invalid Authorization header. Expected Bearer <OPENCODE_SERVER_PASSWORD>' } 
            });
        }

        const token = authHeader.split(' ')[1];
        if (token !== serverPassword) {
            return res.status(401).json({ error: { message: 'Invalid API key' } });
        }
    }
    next();
});

// Endpoint: GET /v1/models
app.get('/v1/models', async (req, res) => {
    try {
        const client = getClient();
        const providersRes = await client.config.providers();
        const providersRaw = providersRes.data?.providers || [];
        
        const models = [];
        
        // Handle both Array and Object (SDK compatibility)
        const providersList = Array.isArray(providersRaw) 
            ? providersRaw 
            : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));

        providersList.forEach((providerInfo) => {
            const providerId = providerInfo.id;
            if (providerInfo.models) {
                Object.entries(providerInfo.models).forEach(([modelId, modelData]) => {
                    models.push({
                        id: `${providerId}/${modelId}`,
                        name: typeof modelData === 'object' ? (modelData.name || modelData.label || modelId) : modelId,
                        object: 'model',
                        created: (modelData && modelData.release_date) 
                            ? Math.floor(new Date(modelData.release_date).getTime() / 1000) 
                            : 1704067200, // Fallback to 2024-01-01
                        owned_by: providerId
                    });
                });
            }
        });

        res.json({
            object: 'list',
            data: models
        });
    } catch (error) {
        console.error('Error fetching models:', error);
        res.status(500).json({ error: { message: 'Failed to fetch models from OpenCode' } });
    }
});

// Endpoint: POST /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: { message: 'messages array is required' } });
        }

        const { providerId, modelId } = parseModel(model);

        const client = getClient();

        console.log(`Using model: ${providerId}/${modelId}${stream ? ' (streaming)' : ''}`);

        const { allParts, fullPromptText, systemPrompt } = await buildPromptPartsAndSystem(messages);
        
        // 1. Set active model
        try {
            await client.config.update({
                body: {
                    activeModel: { providerID: providerId, modelID: modelId }
                }
            });
        } catch (confError) {
            console.warn('Failed to set active model:', confError.message);
        }

        // 2. Create session
         const sessionRes = await client.session.create();
         const sessionId = sessionRes.data?.id;

         if (!sessionId) {
             throw new Error('Failed to create session');
         }
         
         if (stream) {
             res.setHeader('Content-Type', 'text/event-stream');
             res.setHeader('Cache-Control', 'no-cache');
             res.setHeader('Connection', 'keep-alive');

             const id = `chatcmpl-${Date.now()}`;
             let completionTokens = 0;
             let reasoningTokens = 0;
             let insideReasoning = false;
             let hasStartedStreaming = false;

             try {
                 // 3. Send prompt (don't await - fire and forget)
                 client.session.prompt({
                     path: { id: sessionId },
                     body: { 
                         model: {
                             providerID: providerId,
                             modelID: modelId
                         },
                         prompt: fullPromptText.trim(),
                         system: systemPrompt.trim(),
                         parts: allParts
                     }
                 }).catch(err => console.warn('Prompt error:', err.message));

                 // 4. Subscribe to real-time events (SSE)
                 const eventStreamResult = await client.event.subscribe();
                 const eventStream = eventStreamResult.stream;

                 // Keepalive interval
                 const keepaliveInterval = setInterval(() => {
                     if (!res.destroyed) {
                         res.write(': keepalive\n\n');
                     }
                 }, 15000);

                 // Process events
                 for await (const event of eventStream) {
                     if (res.destroyed) break;

                     const eventData = event;
                     
                     // Filter for our session
                     if (eventData.type === 'message.part.updated') {
                         const { part, delta } = eventData.properties;
                         
                         // Skip if not our session
                         if (part.sessionID !== sessionId) continue;

                         // Handle reasoning parts
                         if (part.type === 'reasoning') {
                             if (!insideReasoning) {
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: '<think>\n' },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                                 insideReasoning = true;
                                 hasStartedStreaming = true;
                             }

                             if (delta) {
                                 reasoningTokens += Math.ceil(delta.length / 4);
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: delta },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                             }
                         }
                         // Handle text parts
                         else if (part.type === 'text') {
                             // Close reasoning tag if we were inside it
                             if (insideReasoning) {
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: '\n</think>\n\n' },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                                 insideReasoning = false;
                             }

                             if (delta) {
                                 completionTokens += Math.ceil(delta.length / 4);
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: delta },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                                 hasStartedStreaming = true;
                             }
                         }
                     }

                     // Check if message is complete
                     if (eventData.type === 'message.updated') {
                         const messageInfo = eventData.properties?.info;
                         
                         if (messageInfo?.sessionID === sessionId && messageInfo?.finish === 'stop') {
                             // Close reasoning tag if still open
                             if (insideReasoning) {
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: '\n</think>\n\n' },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                             }

                             // Calculate usage
                             const promptTokens = Math.ceil(fullPromptText.length / 4);
                             const usage = {
                                 prompt_tokens: promptTokens,
                                 completion_tokens: completionTokens + reasoningTokens,
                                 total_tokens: promptTokens + completionTokens + reasoningTokens,
                                 completion_tokens_details: {
                                     reasoning_tokens: reasoningTokens
                                 }
                             };

                             res.write(`data: ${JSON.stringify({
                                 id,
                                 object: 'chat.completion.chunk',
                                 created: Math.floor(Date.now() / 1000),
                                 model: `${providerId}/${modelId}`,
                                 choices: [{
                                     index: 0,
                                     delta: {},
                                     finish_reason: 'stop'
                                 }],
                                 usage
                             })}\n\n`);
                             res.write('data: [DONE]\n\n');
                             clearInterval(keepaliveInterval);
                             res.end();
                             break;
                         }
                     }
                 }

                 clearInterval(keepaliveInterval);
             } catch (streamError) {
                 console.error('Streaming error:', streamError);
                 if (!res.destroyed && !res.headersSent) {
                     res.status(500).json({ 
                         error: { 
                             message: 'Streaming error',
                             details: streamError.message
                         } 
                     });
                 } else if (!res.destroyed) {
                     res.write(`data: ${JSON.stringify({
                         error: { message: streamError.message }
                     })}\n\n`);
                     res.end();
                 }
             }
         } else {
             // 3. Non-streaming: await complete response
             const responseRes = await client.session.prompt({
                 path: { id: sessionId },
                 body: { 
                     model: {
                         providerID: providerId,
                         modelID: modelId
                     },
                     prompt: fullPromptText.trim(),
                     system: systemPrompt.trim(),
                     parts: allParts
                 }
             });

             // Format content
             let content = '';
             let reasoningContent = '';
             const parts = responseRes.data?.parts || [];
             
             content = parts
                 .filter(p => p.type === 'text')
                 .map(p => p.text)
                 .join('\n');
                 
             reasoningContent = parts
                 .filter(p => p.type === 'reasoning')
                 .map(p => p.text)
                 .join('\n');

             if (!content && responseRes.data) {
                 const data = responseRes.data;
                 if (typeof data === 'string') content = data;
                 else content = data?.message || JSON.stringify(data);
             }
             
             // Calculate usage
             const promptTokens = fullPromptText.length / 4; 
             const completionTokens = content.length / 4;
             const reasoningTokens = reasoningContent.length / 4;
             const totalTokens = promptTokens + completionTokens + reasoningTokens;

             const usage = {
                 prompt_tokens: Math.ceil(promptTokens),
                 completion_tokens: Math.ceil(completionTokens + reasoningTokens),
                 total_tokens: Math.ceil(totalTokens),
                 completion_tokens_details: {
                     reasoning_tokens: Math.ceil(reasoningTokens)
                 }
             };

             // Combine reasoning into content for non-streaming
             let finalContent = content;
             if (reasoningContent) {
                 finalContent = `<think>\n${reasoningContent}\n</think>\n\n${content}`;
             }

             const result = {
                 id: `chatcmpl-${Date.now()}`,
                 object: 'chat.completion',
                 created: Math.floor(Date.now() / 1000),
                 model: `${providerId}/${modelId}`,
                 choices: [{
                     index: 0,
                     message: {
                         role: 'assistant',
                         content: finalContent
                     },
                     finish_reason: 'stop'
                 }],
                 usage: usage
             };
             return res.json(result);
         }

    } catch (error) {
        console.error('Proxy Processing Error:', error);
        const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
        res.status(500).json({ 
            error: { 
                message: 'Internal Proxy Error',
                details: errorMessage
            } 
        });
    }
});

app.post('/v1/responses', async (req, res) => {
    try {
        const {
            input,
            instructions,
            model,
            stream,
            previous_response_id: previousResponseId,
            tools,
            tool_choice: toolChoice,
            parallel_tool_calls: parallelToolCalls
        } = req.body || {};

        const normalizedToolsResult = normalizeTools(tools);
        if (normalizedToolsResult.error) {
            return res.status(400).json({
                error: {
                    message: normalizedToolsResult.error,
                    type: 'invalid_request_error'
                }
            });
        }

        const normalizedTools = normalizedToolsResult.tools;
        const normalizedToolChoice = normalizeToolChoice(toolChoice);
        if (normalizedToolChoice.mode === 'invalid') {
            return res.status(400).json({
                error: {
                    message: normalizedToolChoice.reason,
                    type: 'invalid_request_error'
                }
            });
        }

        if (normalizedToolChoice.mode === 'required' && normalizedTools.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'tool_choice=required requires at least one function tool',
                    type: 'invalid_request_error'
                }
            });
        }

        if (normalizedToolChoice.mode === 'required' && normalizedToolChoice.name) {
            const hasNamedTool = normalizedTools.some((tool) => tool.name === normalizedToolChoice.name);
            if (!hasNamedTool) {
                return res.status(400).json({
                    error: {
                        message: `tool_choice requires unknown function: ${normalizedToolChoice.name}`,
                        type: 'invalid_request_error'
                    }
                });
            }
        }

        const functionCallOutputs = extractFunctionCallOutputs(input);

        let previousState = null;
        if (previousResponseId) {
            previousState = getResponseState(previousResponseId);
            if (!previousState) {
                return res.status(400).json({
                    error: {
                        message: 'Invalid or expired previous_response_id',
                        type: 'invalid_request_error'
                    }
                });
            }
        }

        const resolvedTargets = resolveFunctionCallOutputTargets(
            functionCallOutputs,
            previousResponseId,
            previousState
        );
        if (resolvedTargets.error) {
            return res.status(400).json({ error: resolvedTargets.error });
        }

        const ownershipByCallId = resolvedTargets.ownershipByCallId;
        previousState = resolvedTargets.continuationState;

        const continuationValidation = validateFunctionCallOutputs(functionCallOutputs, ownershipByCallId);
        if (continuationValidation.error) {
            return res.status(400).json({ error: continuationValidation.error });
        }
        const validatedFunctionCallOutputs = continuationValidation.validOutputs;

        const selectedModel = model || previousState?.model || 'opencode/big-pickle';
        const { providerId, modelId } = parseModel(selectedModel);
        const client = getClient();

        try {
            await client.config.update({
                body: {
                    activeModel: { providerID: providerId, modelID: modelId }
                }
            });
        } catch (confError) {
            console.warn('Failed to set active model:', confError.message);
        }

        let sessionId = previousState?.sessionId;
        if (!sessionId) {
            const sessionRes = await client.session.create();
            sessionId = sessionRes.data?.id;
            if (!sessionId) {
                throw new Error('Failed to create session');
            }
        }

        let normalizedInput = input;
        if (validatedFunctionCallOutputs.length > 0) {
            const passthroughItems = Array.isArray(input)
                ? input.filter((item) => item?.type !== 'function_call_output')
                : [];

            const toolOutputMessages = validatedFunctionCallOutputs.map(({ output, call }) => {
                return {
                    role: 'user',
                    content: `Tool output for ${call.name} (${output.call_id}): ${toToolResultString(output.output)}`
                };
            });

            normalizedInput = [...passthroughItems, ...toolOutputMessages];

            const resolvedByOwner = new Map();
            for (const { ownerResponseId, output } of validatedFunctionCallOutputs) {
                const resolvedSet = resolvedByOwner.get(ownerResponseId) || new Set();
                resolvedSet.add(output.call_id);
                resolvedByOwner.set(ownerResponseId, resolvedSet);
            }

            for (const [ownerResponseId, resolvedCallIds] of resolvedByOwner.entries()) {
                const ownerState = getResponseState(ownerResponseId);
                if (!ownerState) {
                    continue;
                }

                const updatedPendingToolCalls = (ownerState.pendingToolCalls || []).map((call) => {
                    return resolvedCallIds.has(call.call_id)
                        ? { ...call, status: 'completed' }
                        : call;
                });

                storeResponseState(ownerResponseId, {
                    ...ownerState,
                    pendingToolCalls: updatedPendingToolCalls
                });
            }
        }

        const messages = normalizeResponsesInputToMessages({ input: normalizedInput, instructions });

        if (normalizedTools.length > 0) {
            const toolInstruction = buildToolSystemInstruction(normalizedTools, normalizedToolChoice, parallelToolCalls === true);
            messages.unshift({ role: 'system', content: toolInstruction });
        }

        if (messages.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'input is required when no usable previous_response_id context is provided',
                    type: 'invalid_request_error'
                }
            });
        }

        const { allParts, fullPromptText, systemPrompt } = await buildPromptPartsAndSystem(messages);

        const createdAt = Math.floor(Date.now() / 1000);
        const responseId = createId('resp');
        const outputMessageId = createId('msg');
        const enableTools = normalizedTools.length > 0 && normalizedToolChoice.mode !== 'none';

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let completionText = '';
            let reasoningText = '';
            let insideReasoning = false;
            let responseCompleted = false;
            let assistantMessageStarted = false;

            sendResponseSseEvent(res, {
                type: 'response.created',
                response: {
                    id: responseId,
                    object: 'response',
                    created_at: createdAt,
                    status: 'in_progress',
                    model: `${providerId}/${modelId}`
                }
            });

            const ensureAssistantMessageStarted = () => {
                if (assistantMessageStarted) {
                    return;
                }

                sendResponseSseEvent(res, {
                    type: 'response.output_item.added',
                    response_id: responseId,
                    output_index: 0,
                    item: {
                        id: outputMessageId,
                        type: 'message',
                        role: 'assistant',
                        status: 'in_progress',
                        content: [{ type: 'output_text', text: '' }]
                    }
                });

                assistantMessageStarted = true;
            };

            try {
                client.session.prompt({
                    path: { id: sessionId },
                    body: {
                        model: {
                            providerID: providerId,
                            modelID: modelId
                        },
                        prompt: fullPromptText,
                        system: systemPrompt,
                        parts: allParts
                    }
                }).catch((err) => console.warn('Prompt error:', err.message));

                const eventStreamResult = await client.event.subscribe();
                const eventStream = eventStreamResult.stream;

                const keepaliveInterval = setInterval(() => {
                    if (!res.destroyed) {
                        res.write(': keepalive\n\n');
                    }
                }, 15000);

                for await (const event of eventStream) {
                    if (res.destroyed) {
                        break;
                    }

                    if (event.type === 'message.part.updated') {
                        const { part, delta } = event.properties;
                        if (part.sessionID !== sessionId || !delta) {
                            continue;
                        }

                        if (part.type === 'reasoning') {
                            if (!insideReasoning) {
                                if (!enableTools) {
                                    ensureAssistantMessageStarted();
                                    sendResponseSseEvent(res, {
                                        type: 'response.output_text.delta',
                                        response_id: responseId,
                                        output_index: 0,
                                        content_index: 0,
                                        delta: '<think>\n'
                                    });
                                }
                                reasoningText += '<think>\n';
                                insideReasoning = true;
                            }

                            if (!enableTools) {
                                ensureAssistantMessageStarted();
                                sendResponseSseEvent(res, {
                                    type: 'response.output_text.delta',
                                    response_id: responseId,
                                    output_index: 0,
                                    content_index: 0,
                                    delta
                                });
                            }
                            reasoningText += delta;
                        } else if (part.type === 'text') {
                            if (insideReasoning) {
                                if (!enableTools) {
                                    ensureAssistantMessageStarted();
                                    sendResponseSseEvent(res, {
                                        type: 'response.output_text.delta',
                                        response_id: responseId,
                                        output_index: 0,
                                        content_index: 0,
                                        delta: '\n</think>\n\n'
                                    });
                                }
                                reasoningText += '\n</think>\n\n';
                                insideReasoning = false;
                            }

                            if (!enableTools) {
                                ensureAssistantMessageStarted();
                                sendResponseSseEvent(res, {
                                    type: 'response.output_text.delta',
                                    response_id: responseId,
                                    output_index: 0,
                                    content_index: 0,
                                    delta
                                });
                            }
                            completionText += delta;
                        }
                    }

                    if (event.type === 'message.updated') {
                        const messageInfo = event.properties?.info;
                        if (messageInfo?.sessionID === sessionId && messageInfo?.finish === 'stop') {
                            if (insideReasoning) {
                                if (!enableTools) {
                                    ensureAssistantMessageStarted();
                                    sendResponseSseEvent(res, {
                                        type: 'response.output_text.delta',
                                        response_id: responseId,
                                        output_index: 0,
                                        content_index: 0,
                                        delta: '\n</think>\n\n'
                                    });
                                }
                                reasoningText += '\n</think>\n\n';
                            }

                            const usage = buildResponsesUsage(fullPromptText, completionText, reasoningText);
                            const extracted = enableTools
                                ? extractToolCallsFromText(completionText)
                                : { toolCalls: [], malformed: false };
                            const toolCalls = extracted.toolCalls;

                            if (enableTools && extracted.malformed) {
                                sendResponseSseEvent(res, {
                                    type: 'error',
                                    error: {
                                        message: 'Malformed tool call payload from model output',
                                        type: 'invalid_response_error'
                                    }
                                });
                                res.end();
                                responseCompleted = true;
                                break;
                            }

                            if (enableTools && normalizedToolChoice.mode === 'required' && toolCalls.length === 0) {
                                sendResponseSseEvent(res, {
                                    type: 'error',
                                    error: {
                                        message: 'Model did not produce required function call output',
                                        type: 'invalid_response_error'
                                    }
                                });
                                res.end();
                                responseCompleted = true;
                                break;
                            }

                            if (toolCalls.length > 0 && parallelToolCalls !== true && toolCalls.length > 1) {
                                sendResponseSseEvent(res, {
                                    type: 'error',
                                    error: {
                                        message: 'Model returned multiple tool calls while parallel_tool_calls is false',
                                        type: 'invalid_response_error'
                                    }
                                });
                                res.end();
                                responseCompleted = true;
                                break;
                            }

                            if (toolCalls.length > 0) {
                                const validatedCalls = [];
                                for (const toolCall of toolCalls) {
                                    const toolDef = normalizedTools.find((tool) => tool.name === toolCall.name);
                                    if (!toolDef) {
                                        sendResponseSseEvent(res, {
                                            type: 'error',
                                            error: {
                                                message: `Model attempted unknown tool: ${toolCall.name}`,
                                                type: 'invalid_response_error'
                                            }
                                        });
                                        res.end();
                                        responseCompleted = true;
                                        break;
                                    }
                                    validatedCalls.push(toolCall);
                                }

                                if (responseCompleted) {
                                    break;
                                }

                                if (normalizedToolChoice.mode === 'required' && normalizedToolChoice.name) {
                                    const hasRequiredCall = validatedCalls.some((call) => call.name === normalizedToolChoice.name);
                                    if (!hasRequiredCall) {
                                        sendResponseSseEvent(res, {
                                            type: 'error',
                                            error: {
                                                message: `Model did not call required function: ${normalizedToolChoice.name}`,
                                                type: 'invalid_response_error'
                                            }
                                        });
                                        res.end();
                                        responseCompleted = true;
                                        break;
                                    }
                                }

                                const outputItems = buildFunctionCallOutputItems(validatedCalls);
                                for (let idx = 0; idx < outputItems.length; idx += 1) {
                                    const outputItem = outputItems[idx];

                                    sendResponseSseEvent(res, {
                                        type: 'response.output_item.added',
                                        response_id: responseId,
                                        output_index: idx,
                                        item: {
                                            id: outputItem.id,
                                            type: 'function_call',
                                            call_id: outputItem.call_id,
                                            name: outputItem.name,
                                            arguments: '',
                                            status: 'in_progress'
                                        }
                                    });

                                    sendResponseSseEvent(res, {
                                        type: 'response.function_call_arguments.delta',
                                        response_id: responseId,
                                        output_index: idx,
                                        item_id: outputItem.id,
                                        delta: outputItem.arguments
                                    });

                                    sendResponseSseEvent(res, {
                                        type: 'response.function_call_arguments.done',
                                        response_id: responseId,
                                        output_index: idx,
                                        item_id: outputItem.id,
                                        arguments: outputItem.arguments
                                    });

                                    sendResponseSseEvent(res, {
                                        type: 'response.output_item.done',
                                        response_id: responseId,
                                        output_index: idx,
                                        item: outputItem
                                    });
                                }

                                sendResponseSseEvent(res, {
                                    type: 'response.completed',
                                    response: {
                                        id: responseId,
                                        object: 'response',
                                        created_at: createdAt,
                                        status: 'completed',
                                        model: `${providerId}/${modelId}`,
                                        output: outputItems,
                                        usage,
                                        error: null
                                    }
                                });

                                storeResponseState(responseId, {
                                    sessionId,
                                    model: `${providerId}/${modelId}`,
                                    pendingToolCalls: outputItems.map((item) => ({
                                        call_id: item.call_id,
                                        name: item.name,
                                        arguments: item.arguments,
                                        item_id: item.id,
                                        status: 'pending'
                                    }))
                                });

                                res.write('data: [DONE]\n\n');
                                clearInterval(keepaliveInterval);
                                res.end();
                                responseCompleted = true;
                                break;
                            }

                            ensureAssistantMessageStarted();
                            sendResponseSseEvent(res, {
                                type: 'response.output_item.done',
                                response_id: responseId,
                                output_index: 0,
                                item: {
                                    id: outputMessageId,
                                    type: 'message',
                                    role: 'assistant',
                                    status: 'completed',
                                    content: [{ type: 'output_text', text: `${reasoningText}${completionText}` }]
                                }
                            });

                            sendResponseSseEvent(res, {
                                type: 'response.completed',
                                response: {
                                    id: responseId,
                                    object: 'response',
                                    created_at: createdAt,
                                    status: 'completed',
                                    model: `${providerId}/${modelId}`,
                                    output: [{
                                        id: outputMessageId,
                                        type: 'message',
                                        role: 'assistant',
                                        status: 'completed',
                                        content: [{ type: 'output_text', text: `${reasoningText}${completionText}` }]
                                    }],
                                    usage,
                                    error: null
                                }
                            });

                            storeResponseState(responseId, {
                                sessionId,
                                model: `${providerId}/${modelId}`,
                                pendingToolCalls: []
                            });

                            res.write('data: [DONE]\n\n');
                            clearInterval(keepaliveInterval);
                            res.end();
                            responseCompleted = true;
                            break;
                        }
                    }
                }

                clearInterval(keepaliveInterval);
            } catch (streamError) {
                console.error('Responses streaming error:', streamError);
                if (!res.destroyed) {
                    sendResponseSseEvent(res, {
                        type: 'error',
                        error: {
                            message: streamError.message
                        }
                    });
                    res.end();
                }
            }

            return;
        }

        const responseRes = await client.session.prompt({
            path: { id: sessionId },
            body: {
                model: {
                    providerID: providerId,
                    modelID: modelId
                },
                prompt: fullPromptText,
                system: systemPrompt,
                parts: allParts
            }
        });

        const parts = responseRes.data?.parts || [];
        const content = parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n');
        const reasoningContent = parts
            .filter((p) => p.type === 'reasoning')
            .map((p) => p.text)
            .join('\n');

        const finalOutputText = buildResponsesOutputText(content, reasoningContent);
        const usage = buildResponsesUsage(fullPromptText, content, reasoningContent);

        const extractedToolCalls = enableTools
            ? extractToolCallsFromText(content)
            : { toolCalls: [], malformed: false };
        const toolCalls = extractedToolCalls.toolCalls;

        if (enableTools && extractedToolCalls.malformed) {
            return res.status(500).json({
                error: {
                    message: 'Malformed tool call payload from model output',
                    type: 'invalid_response_error'
                }
            });
        }

        if (enableTools && normalizedToolChoice.mode === 'required' && toolCalls.length === 0) {
            return res.status(500).json({
                error: {
                    message: 'Model did not produce required function call output',
                    type: 'invalid_response_error'
                }
            });
        }

        if (toolCalls.length > 0 && parallelToolCalls !== true && toolCalls.length > 1) {
            return res.status(500).json({
                error: {
                    message: 'Model returned multiple tool calls while parallel_tool_calls is false',
                    type: 'invalid_response_error'
                }
            });
        }

        if (toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
                const toolDef = normalizedTools.find((tool) => tool.name === toolCall.name);
                if (!toolDef) {
                    return res.status(400).json({
                        error: {
                            message: `Model attempted unknown tool: ${toolCall.name}`,
                            type: 'invalid_response_error'
                        }
                    });
                }
            }

            if (normalizedToolChoice.mode === 'required' && normalizedToolChoice.name) {
                const hasRequiredCall = toolCalls.some((call) => call.name === normalizedToolChoice.name);
                if (!hasRequiredCall) {
                    return res.status(500).json({
                        error: {
                            message: `Model did not call required function: ${normalizedToolChoice.name}`,
                            type: 'invalid_response_error'
                        }
                    });
                }
            }

            const output = buildFunctionCallOutputItems(toolCalls);

            storeResponseState(responseId, {
                sessionId,
                model: `${providerId}/${modelId}`,
                pendingToolCalls: output.map((item) => ({
                    call_id: item.call_id,
                    name: item.name,
                    arguments: item.arguments,
                    item_id: item.id,
                    status: 'pending'
                }))
            });

            return res.json({
                id: responseId,
                object: 'response',
                created_at: createdAt,
                status: 'completed',
                model: `${providerId}/${modelId}`,
                output,
                parallel_tool_calls: parallelToolCalls === true,
                usage,
                error: null
            });
        }

        storeResponseState(responseId, {
            sessionId,
            model: `${providerId}/${modelId}`,
            pendingToolCalls: []
        });

        return res.json({
            id: responseId,
            object: 'response',
            created_at: createdAt,
            status: 'completed',
            model: `${providerId}/${modelId}`,
            output: [{
                id: outputMessageId,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: finalOutputText }]
            }],
            output_text: finalOutputText,
            parallel_tool_calls: parallelToolCalls === true,
            usage,
            error: null
        });
    } catch (error) {
        console.error('Responses API Proxy Error:', error);
        const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
        return res.status(500).json({
            error: {
                message: 'Internal Proxy Error',
                details: errorMessage
            }
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', proxy: true });
});

export default app;
