import request from 'supertest';
import { jest } from '@jest/globals';

// Define o mock antes de importar o app
jest.unstable_mockModule('axios', () => ({
    default: {
        get: jest.fn(async () => ({
            data: Buffer.from('fake-image-data'),
            headers: { 'content-type': 'image/png' }
        }))
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => {
        let lastPromptText = '';
        let lastPromptBody = null;

        return ({
        config: {
            providers: jest.fn(async () => ({
                data: {
                    providers: [
                        {
                            id: 'opencode',
                            models: {
                                'gpt-5-nano': { id: 'gpt-5-nano' }
                            }
                        }
                    ]
                }
            })),
            update: jest.fn(async () => ({}))
        },
        session: {
            create: jest.fn(async () => ({
                data: { id: 'test-session-id' }
            })),
            prompt: jest.fn(async (args) => {
                const promptText = args.body.prompt || '';
                lastPromptText = promptText;
                lastPromptBody = args.body || null;
                const systemText = args.body.system || '';

                if (promptText.includes('Inspect langchain policy bypass')) {
                    return {
                        data: {
                            parts: [{
                                type: 'text',
                                text: systemText.includes('TOOLS AVAILABLE:')
                                    ? 'proxy-policy-applied'
                                    : 'proxy-policy-bypassed'
                            }]
                        }
                    };
                }

                if (promptText.includes('Inspect upstream tools policy')) {
                    const toolsPolicy = args.body.tools || {};
                    const disabled = Object.entries(toolsPolicy)
                        .filter(([, value]) => value === false)
                        .map(([key]) => key)
                        .sort();

                    return {
                        data: {
                            parts: [{
                                type: 'text',
                                text: disabled.join(',')
                            }]
                        }
                    };
                }

                if (promptText.includes('Use weather tool') && !promptText.includes('Tool output for weather')) {
                    return {
                        data: {
                            parts: [{
                                type: 'text',
                                text: '{"tool_calls":[{"name":"weather","arguments":{"city":"Rome"}}]}'
                            }]
                        }
                    };
                }

                if (promptText.includes('Use weather and time tool') && !promptText.includes('Tool output for')) {
                    return {
                        data: {
                            parts: [{
                                type: 'text',
                                text: '{"tool_calls":[{"name":"weather","arguments":{"city":"Rome"}},{"name":"time","arguments":{"city":"Rome"}}]}'
                            }]
                        }
                    };
                }

                if (promptText.includes('Use formatter tool')) {
                    return {
                        data: {
                            parts: [{
                                type: 'text',
                                text: '{"tool_calls":[{"name":"format_final_json_response","arguments":{"facts":["Cats sleep 12-16 hours"]}}]}'
                            }]
                        }
                    };
                }

                if (promptText.includes('Use formatter prose tool')) {
                    return {
                        data: {
                            parts: [{
                                type: 'text',
                                text: 'I will now format the response.\n```\n{"tool_calls":[{"name":"format_final_json_response","arguments":{"facts":["Cats sleep 12-16 hours"]}}]}\n```'
                            }]
                        }
                    };
                }

                if (promptText.includes('Tool output for weather')) {
                    return {
                        data: {
                            parts: [{ type: 'text', text: 'The weather in Rome is sunny.' }]
                        }
                    };
                }

                const parts = [{ type: 'text', text: 'Resposta simulada' }];
                
                if (promptText.includes('reasoning')) {
                    parts.unshift({ type: 'reasoning', text: 'Thinking process...' });
                }
                
                return {
                    data: { parts }
                };
            })
        },
        tool: {
            ids: jest.fn(async () => ({
                data: ['bash', 'task']
            }))
        },
        event: {
            subscribe: jest.fn(async () => {
                const sessionId = 'test-session-id';
                return {
                    stream: (async function* () {
                        const shouldEmitToolCalls = (lastPromptText.includes('Use weather tool') || lastPromptText.includes('Use weather and time tool'))
                            && !lastPromptText.includes('Tool output for weather');
                        const shouldEmitFormatterCall = lastPromptText.includes('Use formatter tool');
                        const shouldEmitFormatterProseCall = lastPromptText.includes('Use formatter prose tool');
                        const shouldEmitFormatterDeltaCall = lastPromptText.includes('Use formatter delta tool');

                        const mockEvents = shouldEmitToolCalls
                            ? [
                                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: '{"tool_calls":[' } },
                                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: lastPromptText.includes('Use weather and time tool')
                                    ? '{"name":"weather","arguments":{"city":"Rome"}},{"name":"time","arguments":{"city":"Rome"}}]}'
                                    : '{"name":"weather","arguments":{"city":"Rome"}}]}' } },
                                { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
                            ]
                            : shouldEmitFormatterCall
                                ? [
                                    { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: '{"tool_calls":[{"name":"format_final_json_response","arguments":{"facts":["Cats sleep 12-16 hours"]}}]}' } },
                                    { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
                                ]
                            : shouldEmitFormatterProseCall
                                ? [
                                    { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: 'I will now format the response.\n```\n{"tool_calls":[{"name":"format_final_json_response","arguments":{"facts":["Cats sleep 12-16 hours"]}}]}\n```' } },
                                    { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
                                ]
                            : shouldEmitFormatterDeltaCall
                                ? [
                                    {
                                        type: 'message.part.delta',
                                        properties: {
                                            part: {
                                                type: 'tool',
                                                sessionID: sessionId,
                                                call_id: 'call_fmt_1',
                                                name: 'format_final_json_response'
                                            },
                                            delta: {
                                                arguments: '{"facts":["Cats sleep 12-16 hours"]}'
                                            }
                                        }
                                    },
                                    { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
                                ]
                            : [
                                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: 'Thinking...' } },
                                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: 'Resposta' } },
                                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: ' simulada' } },
                                { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
                            ];

                        for (const event of mockEvents) {
                            yield event;
                        }
                    })()
                };
            })
        },
        __test: {
            getLastPromptBody: () => lastPromptBody
        }
    });
    })
}));

// Importa o app dinamicamente para que o mock seja aplicado
const { default: app } = await import('../app.js');

function parseSseEvents(bodyText) {
    return bodyText
        .split('\n\n')
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.startsWith('data: ') && chunk !== 'data: [DONE]')
        .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

describe('Proxy OpenAI API', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, OPENCODE_SERVER_PASSWORD: 'test-password' };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('GET /health deve retornar status ok sem auth', async () => {
        // Removemos a auth do health no app.js se necessário, ou passamos aqui
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toEqual({ status: 'ok', proxy: true });
    });

    test('Deve falhar sem autenticação nos endpoints v1', async () => {
        const res = await request(app).get('/v1/models');
        expect(res.statusCode).toEqual(401);
    });

    test('GET /v1/models deve retornar lista de modelos compatível com OpenAI', async () => {
        const res = await request(app)
            .get('/v1/models')
            .set('Authorization', 'Bearer test-password');

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('list');
        expect(res.body.data[0].id).toEqual('opencode/gpt-5-nano');
    });

    test('POST /v1/chat/completions deve retornar chat completion', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                messages: [{ role: 'user', content: 'Olá' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
        expect(res.body.choices[0].message.content).toEqual('Resposta simulada');
    });

    test('POST /v1/chat/completions deve suportar streaming com tags <think>', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                messages: [{ role: 'user', content: 'Olá' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('data: {"id"');
        expect(res.text).toContain('data: [DONE]');
        // Validar que há resposta (não necessariamente a tag <think> por ser um stream mock)
        expect(res.text).toContain('Resposta');
    });

    test('POST /v1/chat/completions deve suportar streaming com reasoning inline', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                messages: [{ role: 'user', content: 'Teste com reasoning' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        // Validar que há chunks com <think>
        expect(res.text).toContain('<think>');
        // Validar que há chunks com </think>
        expect(res.text).toContain('</think>');
        // Validar conclusão
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions deve suportar conteúdo multimodal (imagens)', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                messages: [{ 
                    role: 'user', 
                    content: [
                        { type: 'text', text: 'O que tem nesta imagem?' },
                        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
                    ]
                }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('Resposta simulada');
    });

    test('POST /v1/chat/completions deve retornar tokens de reasoning quando disponiveis (non-streaming)', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                messages: [{ role: 'user', content: 'Teste com reasoning' }]
            });

        expect(res.statusCode).toEqual(200);
        // Validar que o conteúdo inclui a tag <think> para non-streaming
        expect(res.body.choices[0].message.content).toContain('<think>\nThinking process...\n</think>\n\nResposta simulada');
        // 'Thinking process...' tem 19 chars -> ~5 tokens
        expect(res.body.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);
        // Validar que o campo reasoning_content não existe
        expect(res.body.choices[0].message.reasoning_content).toBeUndefined();
    });

    test('POST /v1/responses deve retornar formato de response no non-streaming', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Olá'
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.status).toEqual('completed');
        expect(res.body.output[0].type).toEqual('message');
        expect(res.body.output[0].content[0].type).toEqual('output_text');
    });

    test('POST /v1/responses deve suportar stream no formato responses', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Olá',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('"type":"response.created"');
        expect(res.text).toContain('"type":"response.output_text.delta"');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses deve suportar previous_response_id', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Primeira mensagem'
            });

        expect(first.statusCode).toEqual(200);
        expect(first.body.id).toBeDefined();

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: first.body.id,
                input: 'Continuação'
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.object).toEqual('response');
    });

    test('POST /v1/responses deve rejeitar previous_response_id inválido', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: 'resp_invalido',
                input: 'teste'
            });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.message).toContain('previous_response_id');
    });

    test('POST /v1/responses deve retornar function_call quando tools forem fornecidas', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].type).toEqual('function_call');
        expect(res.body.output[0].id).toMatch(/^fc_/);
        expect(res.body.output[0].call_id).toMatch(/^call_/);
        expect(res.body.output[0].name).toEqual('weather');
        expect(res.body.output[0].arguments).toContain('Rome');
    });

    test('POST /v1/responses deve manter instrução de tools para user-agent do LangChain', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .set('User-Agent', 'langchainjs-openai/1.0.0')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Inspect langchain policy bypass',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('message');
        expect(res.body.output[0].content[0].text).toEqual('proxy-policy-applied');
    });

    test('POST /v1/responses deve manter instrução de tools para user-agent não LangChain', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .set('User-Agent', 'custom-client/1.0')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Inspect langchain policy bypass',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('message');
        expect(res.body.output[0].content[0].text).toEqual('proxy-policy-applied');
    });

    test('POST /v1/responses deve aceitar tool function no formato top-level compatível com LangChain', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{
                    type: 'function',
                    name: 'weather',
                    description: 'Get weather by city',
                    parameters: { type: 'object', properties: {} }
                }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].type).toEqual('function_call');
        expect(res.body.output[0].name).toEqual('weather');
    });

    test('POST /v1/responses deve desabilitar tools internos upstream', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Inspect upstream tools policy'
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('message');
        expect(res.body.output[0].content[0].text).toEqual('bash,task');
    });

    test('POST /v1/responses deve falhar quando structured parser mode não gera function call', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Pergunta simples sem uso de ferramenta',
                tools: [
                    { type: 'function', function: { name: 'weather', parameters: { type: 'object' } } },
                    { type: 'function', function: { name: 'format_final_json_response', parameters: { type: 'object' } } }
                ]
            });

        expect(res.statusCode).toEqual(500);
        expect(res.body.error.type).toEqual('invalid_response_error');
        expect(res.body.error.message).toContain('Structured parser mode requires at least one function call output');
    });

    test('POST /v1/responses deve aceitar structured parser mode quando houver function call', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use formatter tool',
                tools: [
                    { type: 'function', function: { name: 'format_final_json_response', parameters: { type: 'object' } } }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('function_call');
        expect(res.body.output[0].name).toEqual('format_final_json_response');
    });

    test('POST /v1/responses deve extrair function_call de message.part.delta em structured parser mode', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use formatter delta tool',
                tools: [
                    { type: 'function', function: { name: 'format_final_json_response', parameters: { type: 'object' } } }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('function_call');
        expect(res.body.output[0].name).toEqual('format_final_json_response');
        expect(res.body.output[0].arguments).toContain('Cats sleep 12-16 hours');
    });

    test('POST /v1/responses deve extrair function_call quando tool json vier com prose', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use formatter prose tool',
                tools: [
                    { type: 'function', function: { name: 'format_final_json_response', parameters: { type: 'object' } } }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('function_call');
        expect(res.body.output[0].name).toEqual('format_final_json_response');
    });

    test('POST /v1/responses deve falhar explicitamente quando tool_choice=required não gera tool call', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Pergunta sem chamada de ferramenta',
                tool_choice: 'required',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(res.statusCode).toEqual(500);
        expect(res.body.error.type).toEqual('invalid_response_error');
        expect(res.body.error.message).toContain('required function call');
    });

    test('POST /v1/responses deve aceitar function_call_output e continuar a resposta', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(first.statusCode).toEqual(200);
        const callId = first.body.output[0].call_id;

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: first.body.id,
                input: [{
                    type: 'function_call_output',
                    call_id: callId,
                    output: { weather: 'sunny' }
                }]
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.output[0].type).toEqual('message');
        expect(second.body.output[0].content[0].text).toContain('sunny');
    });

    test('POST /v1/responses deve aceitar function_call_output sem previous_response_id quando call_id for conhecido', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(first.statusCode).toEqual(200);
        const callId = first.body.output[0].call_id;

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                input: [{
                    type: 'function_call_output',
                    call_id: callId,
                    output: { weather: 'sunny' }
                }]
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.output[0].type).toEqual('message');
        expect(second.body.output[0].content[0].text).toContain('sunny');
    });

    test('POST /v1/responses deve rejeitar function_call_output com call_id desconhecido', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(first.statusCode).toEqual(200);

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: first.body.id,
                input: [{
                    type: 'function_call_output',
                    call_id: 'call_unknown',
                    output: { weather: 'sunny' }
                }]
            });

        expect(second.statusCode).toEqual(400);
        expect(second.body.error.type).toEqual('invalid_request_error');
        expect(second.body.error.message).toContain('Unknown function_call_output call_id');
    });

    test('POST /v1/responses deve rejeitar function_call_output sem previous_response_id e call_id desconhecido', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                input: [{
                    type: 'function_call_output',
                    call_id: 'call_unknown',
                    output: { weather: 'sunny' }
                }]
            });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.type).toEqual('invalid_request_error');
        expect(res.body.error.message).toContain('Unknown function_call_output call_id');
    });

    test('POST /v1/responses deve aceitar múltiplos function_call_output sem previous_response_id no mesmo contexto', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(first.statusCode).toEqual(200);
        expect(second.statusCode).toEqual(200);

        const resume = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                input: [
                    {
                        type: 'function_call_output',
                        call_id: first.body.output[0].call_id,
                        output: { weather: 'sunny' }
                    },
                    {
                        type: 'function_call_output',
                        call_id: second.body.output[0].call_id,
                        output: { weather: 'sunny' }
                    }
                ]
            });

        expect(resume.statusCode).toEqual(200);
        expect(resume.body.output[0].type).toEqual('message');
    });

    test('POST /v1/responses deve tratar reenvio duplicado de function_call_output como idempotente', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        const callId = first.body.output[0].call_id;

        const submit = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: first.body.id,
                input: [{
                    type: 'function_call_output',
                    call_id: callId,
                    output: { weather: 'sunny' }
                }]
            });

        expect(submit.statusCode).toEqual(200);

        const duplicate = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: first.body.id,
                input: [{
                    type: 'function_call_output',
                    call_id: callId,
                    output: { weather: 'cloudy' }
                }]
            });

        expect(duplicate.statusCode).toEqual(200);
        expect(duplicate.body.object).toEqual('response');
        expect(duplicate.body.output[0].type).toEqual('message');
    });

    test('POST /v1/responses deve suportar parallel_tool_calls=true com múltiplos function calls', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather and time tool',
                parallel_tool_calls: true,
                tools: [
                    { type: 'function', function: { name: 'weather', parameters: { type: 'object' } } },
                    { type: 'function', function: { name: 'time', parameters: { type: 'object' } } }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output).toHaveLength(2);
        expect(new Set(res.body.output.map((item) => item.call_id)).size).toEqual(2);
        expect(new Set(res.body.output.map((item) => item.id)).size).toEqual(2);
    });

    test('POST /v1/responses deve rejeitar ferramentas built-in não suportadas', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Search web',
                tools: [{ type: 'web_search' }]
            });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.type).toEqual('invalid_request_error');
        expect(res.body.error.message).toContain('Unsupported built-in tool type');
    });

    test('POST /v1/responses stream deve emitir eventos de function call', async () => {
        const nonStream = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/gpt-5-nano',
                input: 'Use weather tool',
                stream: true,
                tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('"type":"response.output_item.added"');
        expect(res.text).toContain('"type":"response.function_call_arguments.delta"');
        expect(res.text).toContain('"type":"response.function_call_arguments.done"');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('data: [DONE]');

        const events = parseSseEvents(res.text);
        const functionCallDoneEvent = events.find((event) => event.type === 'response.output_item.done' && event.item?.type === 'function_call');

        expect(functionCallDoneEvent).toBeDefined();
        expect(functionCallDoneEvent.item).toMatchObject({
            type: nonStream.body.output[0].type,
            name: nonStream.body.output[0].name,
            arguments: nonStream.body.output[0].arguments,
            status: nonStream.body.output[0].status
        });
        expect(typeof functionCallDoneEvent.item.id).toEqual('string');
        expect(typeof functionCallDoneEvent.item.call_id).toEqual('string');
    });
});
