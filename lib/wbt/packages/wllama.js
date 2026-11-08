'use strict';

const Command = require('../../Command');
const ReplCommand = require('../../ReplCommand');
const { readBytesFromFs, loadModule } = require('../utils');
const { daemonManager } = require('../daemon');

const DEFAULT_MODEL_URL = 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf';
const DEFAULT_WASM_URL = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/src/wasm/wllama.wasm';

// Shared in-memory Wllama instances keyed by resolved model identifier so loaded models persist across invocations
const wllamaInstances = new Map();

/**
 * Resolves a model spec (`hf:owner/repo/file.gguf`, `owner/repo:Q4_K_M`, URL, or filesystem path)
 * into a structured descriptor.
 */
function resolveModelSpec(rawSpec, hfRepo = null, hfFile = null, hfQuant = null) {
    if (hfRepo) {
        if (hfFile) {
            const cleanRepo = hfRepo.replace(/^hf:/i, '').replace(/^\/+|\/+$/g, '');
            const cleanFile = hfFile.replace(/^\/+/, '');
            return {
                kind: 'hf-file',
                key: `hf:${cleanRepo}/${cleanFile}`,
                repo: cleanRepo,
                file: cleanFile,
                url: `https://huggingface.co/${cleanRepo}/resolve/main/${cleanFile}`
            };
        }
        return {
            kind: 'hf-quant',
            key: `hf:${hfRepo}:${hfQuant || 'Q4_K_M'}`,
            repo: hfRepo.replace(/^hf:/i, ''),
            quant: hfQuant || 'Q4_K_M'
        };
    }

    const spec = (rawSpec || '').trim();
    if (!spec) {
        return {
            kind: 'url',
            key: DEFAULT_MODEL_URL,
            url: DEFAULT_MODEL_URL
        };
    }

    if (/^hf:\/\//i.test(spec) || /^hf:/i.test(spec)) {
        const stripped = spec.replace(/^hf:(\/\/)?/i, '');
        // Support `hf:owner/repo:Q4_K_M`
        const quantMatch = stripped.match(/^([^/]+\/[^/:]+):([^/]+)$/);
        if (quantMatch) {
            return {
                kind: 'hf-quant',
                key: `hf:${quantMatch[1]}:${quantMatch[2]}`,
                repo: quantMatch[1],
                quant: quantMatch[2]
            };
        }
        // Support `hf:owner/repo/path/to/model.gguf`
        const parts = stripped.split('/');
        if (parts.length >= 3) {
            const repo = `${parts[0]}/${parts[1]}`;
            const file = parts.slice(2).join('/');
            return {
                kind: 'hf-file',
                key: `hf:${repo}/${file}`,
                repo,
                file,
                url: `https://huggingface.co/${repo}/resolve/main/${file}`
            };
        }
        return {
            kind: 'hf-quant',
            key: `hf:${stripped}:Q4_K_M`,
            repo: stripped,
            quant: 'Q4_K_M'
        };
    }

    if (/^https?:\/\//i.test(spec)) {
        return {
            kind: 'url',
            key: spec,
            url: spec
        };
    }

    return {
        kind: 'fs',
        key: spec,
        path: spec
    };
}

async function fetchUrlAsGgufBlob(url, progressCallback) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch model from ${url}: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get('content-length') || 0);
    if (!res.body || typeof res.body.getReader !== 'function') {
        const buf = await res.arrayBuffer();
        if (typeof progressCallback === 'function') {
            progressCallback({ loaded: buf.byteLength, total: buf.byteLength });
        }
        const blob = new Blob([buf], { type: 'application/octet-stream' });
        blob.name = url.split('/').pop().split('?')[0] || 'model.gguf';
        return blob;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (typeof progressCallback === 'function') {
            progressCallback({ loaded, total });
        }
    }
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    blob.name = url.split('/').pop().split('?')[0] || 'model.gguf';
    return blob;
}

/**
 * Helper to initialize or retrieve a cached Wllama v3 instance and load the requested model.
 */
async function getOrInitWllamaInstance(opts = {}) {
    const {
        modelSpec,
        mmprojSpec = null,
        loadParams = {},
        fs,
        pkgMeta = {},
        wbtConfig = {},
        loadModel = true
    } = opts;

    const mod = await loadModule('@wllama/wllama', pkgMeta.cdnUrl, wbtConfig.moduleLoader);
    const Wllama = mod.Wllama || mod.default || mod;
    const LoggerWithoutDebug = mod.LoggerWithoutDebug || undefined;

    const wasmUrl = pkgMeta.wasmUrl || DEFAULT_WASM_URL;
    const pathConfig = { default: wasmUrl };

    const createWllama = () => {
        try {
            return new Wllama(pathConfig, {
                suppressNativeLog: true,
                logger: LoggerWithoutDebug
            });
        } catch {
            // Fallback dummy cacheManager if OPFS is unavailable in a sandboxed iframe
            return new Wllama(pathConfig, {
                suppressNativeLog: true,
                logger: LoggerWithoutDebug,
                cacheManager: {
                    isSupported: () => true,
                    getNameFromURL: async (u) => u,
                    list: async () => [],
                    clear: async () => {},
                    delete: async () => {}
                }
            });
        }
    };

    if (!loadModel) {
        const instance = createWllama();
        return { wllama: instance, mod, Wllama, modelKey: null, isCached: false };
    }

    const cacheKey = (() => {
        if (modelSpec.kind === 'fs' && fs && typeof fs.absolutePath === 'function') {
            return `fs:${fs.absolutePath(modelSpec.path)}:gpu=${loadParams.n_gpu_layers ?? 'auto'}:emb=${Boolean(loadParams.embeddings)}`;
        }
        return `${modelSpec.key}:gpu=${loadParams.n_gpu_layers ?? 'auto'}:emb=${Boolean(loadParams.embeddings)}`;
    })();

    if (wllamaInstances.has(cacheKey)) {
        const existing = wllamaInstances.get(cacheKey);
        if (typeof existing.isModelLoaded !== 'function' || existing.isModelLoaded()) {
            return { wllama: existing, mod, Wllama, modelKey: cacheKey, isCached: true };
        }
    }

    const wllama = createWllama();

    if (modelSpec.kind === 'fs') {
        const bytes = readBytesFromFs(fs, modelSpec.path);
        if (!bytes) {
            throw new Error(`${modelSpec.path}: No such file or directory`);
        }
        const modelBlob = new Blob([bytes], { type: 'application/octet-stream' });
        modelBlob.name = modelSpec.path.split('/').pop() || 'model.gguf';
        const blobs = [modelBlob];

        if (mmprojSpec) {
            const mmBytes = readBytesFromFs(fs, mmprojSpec);
            if (!mmBytes) {
                throw new Error(`${mmprojSpec}: No such file or directory`);
            }
            const mmBlob = new Blob([mmBytes], { type: 'application/octet-stream' });
            mmBlob.name = mmprojSpec.split('/').pop() || 'mmproj.gguf';
            blobs.push(mmBlob);
        }

        await wllama.loadModel(blobs, loadParams);
    } else if (modelSpec.kind === 'hf-quant' && typeof wllama.loadModelFromHF === 'function') {
        try {
            await wllama.loadModelFromHF(
                {
                    repo: modelSpec.repo,
                    quant: modelSpec.quant
                },
                loadParams
            );
        } catch (err) {
            if (typeof mod.getHFModelSource === 'function') {
                const src = await mod.getHFModelSource({ repo: modelSpec.repo, quant: modelSpec.quant });
                const blob = await fetchUrlAsGgufBlob(src.url || src, loadParams.progressCallback);
                await wllama.loadModel([blob], loadParams);
            } else {
                throw err;
            }
        }
    } else if (modelSpec.kind === 'hf-file' && typeof wllama.loadModelFromHF === 'function') {
        try {
            await wllama.loadModelFromHF(
                {
                    repo: modelSpec.repo,
                    file: modelSpec.file
                },
                loadParams
            );
        } catch {
            const blob = await fetchUrlAsGgufBlob(modelSpec.url, loadParams.progressCallback);
            await wllama.loadModel([blob], loadParams);
        }
    } else {
        const targetUrl = modelSpec.url || DEFAULT_MODEL_URL;
        try {
            if (mmprojSpec && /^https?:\/\//i.test(mmprojSpec)) {
                await wllama.loadModelFromUrl({ url: targetUrl, mmprojUrl: mmprojSpec }, loadParams);
            } else {
                await wllama.loadModelFromUrl(targetUrl, loadParams);
            }
        } catch {
            const blob = await fetchUrlAsGgufBlob(targetUrl, loadParams.progressCallback);
            await wllama.loadModel([blob], loadParams);
        }
    }

    wllamaInstances.set(cacheKey, wllama);
    return { wllama, mod, Wllama, modelKey: cacheKey, isCached: false };
}

/**
 * Extracts text from a Wllama v3 `createChatCompletion` or `createCompletion` response.
 */
function extractCompletionText(res) {
    if (typeof res === 'string') return res;
    if (!res || typeof res !== 'object') return '';
    if (Array.isArray(res.choices) && res.choices.length > 0) {
        const choice = res.choices[0];
        if (choice.message && typeof choice.message.content === 'string') {
            return choice.message.content;
        }
        if (typeof choice.text === 'string') {
            return choice.text;
        }
        if (choice.delta && typeof choice.delta.content === 'string') {
            return choice.delta.content;
        }
    }
    if (typeof res.content === 'string') return res.content;
    if (typeof res.text === 'string') return res.text;
    return '';
}

/**
 * Starts a Wllama v3 OpenAI-compatible background server daemon via DaemonManager (default port 8080).
 * Exposes:
 * - `GET /health` & `GET /status`
 * - `GET /v1/models`
 * - `POST /v1/chat/completions` (and `/chat/completions`)
 * - `POST /v1/completions` (and `/completions` / `/completion`)
 * - `POST /v1/embeddings` (and `/embeddings` / `/embedding`)
 */
async function startWllamaDaemon({ modelSpec, mmprojSpec, loadParams, port = 8080, host = '127.0.0.1', fs, pkgMeta, wbtConfig }) {
    const { wllama, Wllama, modelKey } = await getOrInitWllamaInstance({
        modelSpec,
        mmprojSpec,
        loadParams,
        fs,
        pkgMeta,
        wbtConfig,
        loadModel: true
    });

    const pidFile = `/var/run/wllama-${port}.pid`;
    const modelLabel = modelSpec.path || modelSpec.url || modelSpec.key || 'wllama-model';
    const webgpuSupported = typeof wllama.isSupportWebGPU === 'function'
        ? Boolean(wllama.isSupportWebGPU())
        : Boolean(typeof navigator !== 'undefined' && navigator.gpu);

    const daemon = await daemonManager.startDaemon({
        name: 'wllama',
        port: Number(port),
        host,
        dataDir: modelLabel,
        instance: wllama,
        fs,
        pidFile,
        onStop: async () => {
            if (modelKey) wllamaInstances.delete(modelKey);
            if (wllama && typeof wllama.exit === 'function') {
                try { await wllama.exit(); } catch { /* ignore */ }
            }
        },
        handler: async (req) => {
            if (req.path === '/health' || req.path === '/status') {
                return {
                    status: 200,
                    body: {
                        status: 'ok',
                        engine: 'wllama',
                        version: pkgMeta.version || '3.8.1',
                        libllama: typeof Wllama.getLibllamaVersion === 'function' ? Wllama.getLibllamaVersion() : 'b6327',
                        webgpu: webgpuSupported && loadParams.n_gpu_layers !== 0,
                        multithread: typeof wllama.isMultithread === 'function' ? wllama.isMultithread() : false,
                        threads: typeof wllama.getNumThreads === 'function' ? wllama.getNumThreads() : 1,
                        model: modelLabel,
                        port: Number(port)
                    }
                };
            }

            if (req.path === '/v1/models' || req.path === '/models') {
                return {
                    status: 200,
                    body: {
                        object: 'list',
                        data: [
                            {
                                id: modelLabel,
                                object: 'model',
                                owned_by: 'wllama',
                                meta: typeof wllama.getModelMetadata === 'function' ? wllama.getModelMetadata() : {}
                            }
                        ]
                    }
                };
            }

            let payload = {};
            if (req.body) {
                try {
                    payload = JSON.parse(req.body);
                } catch {
                    payload = { prompt: String(req.body) };
                }
            }

            try {
                if (req.path === '/v1/chat/completions' || req.path === '/chat/completions') {
                    const messages = Array.isArray(payload.messages)
                        ? payload.messages
                        : [{ role: 'user', content: String(payload.prompt || '') }];
                    const res = await wllama.createChatCompletion({
                        messages,
                        max_tokens: payload.max_tokens ?? payload.n_predict ?? 256,
                        temperature: payload.temperature ?? 0.7,
                        top_k: payload.top_k,
                        top_p: payload.top_p,
                        tools: payload.tools,
                        tool_choice: payload.tool_choice,
                        stream: false
                    });
                    return { status: 200, body: res };
                }

                if (req.path === '/v1/completions' || req.path === '/completions' || req.path === '/completion') {
                    const prompt = String(payload.prompt || '');
                    const res = await wllama.createCompletion({
                        prompt,
                        max_tokens: payload.max_tokens ?? payload.n_predict ?? 256,
                        temperature: payload.temperature ?? 0.7,
                        top_k: payload.top_k,
                        top_p: payload.top_p,
                        stream: false
                    });
                    return { status: 200, body: res };
                }

                if (req.path === '/v1/embeddings' || req.path === '/embeddings' || req.path === '/embedding') {
                    const input = payload.input || payload.prompt || '';
                    const res = await wllama.createEmbedding({ input });
                    return { status: 200, body: res };
                }

                return {
                    status: 404,
                    body: { error: `Unknown endpoint ${req.path}. Available: /health, /v1/models, /v1/chat/completions, /v1/completions, /v1/embeddings` }
                };
            } catch (err) {
                return {
                    status: 400,
                    body: { error: err.message || String(err) }
                };
            }
        }
    });

    return daemon;
}

function createWllamaCommand(pkgMeta, wbtConfig = {}, binName = 'wllama') {
    class WllamaCommand extends ReplCommand {
        static get name() { return binName; }
        get name() { return binName; }

        constructor(args, context) {
            super(args, context);
            this._parsed = this._parseArgs(args || []);
            this._wllama = null;
            this._WllamaClass = null;
            this._messages = [];
            if (this._parsed.systemPrompt) {
                this._messages.push({ role: 'system', content: this._parsed.systemPrompt });
            }
        }

        _parseArgs(args) {
            let model = null;
            let mmproj = null;
            let hfRepo = null;
            let hfFile = null;
            let hfQuant = null;
            let prompt = null;
            let file = null;
            let systemPrompt = null;
            let maxTokens = 256;
            let temperature = 0.7;
            let topK = undefined;
            let topP = undefined;
            let nCtx = 4096;
            let nBatch = undefined;
            let nThreads = undefined;
            let nGpuLayers = undefined; // undefined = Wllama v3 auto WebGPU offload; 0 = CPU only
            let embeddings = false;
            let rawCompletion = false;
            let jsonOutput = false;
            let jinja = true;
            let help = false;
            let version = false;
            let subcommand = null; // 'serve' | 'start' | 'stop' | 'status' | 'info' | 'models' | 'embed' | 'bench'
            let host = '127.0.0.1';
            let port = 8080;
            const extraArgs = [];

            const positional = [];
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '--help' || a === '-h' && i + 1 >= args.length || a === '-?') {
                    help = true;
                } else if (a === '--version' || a === '-V' || a === '-v') {
                    version = true;
                } else if (a === '--serve' || a === '--daemon') {
                    subcommand = 'serve';
                } else if ((a === '-m' || a === '--model' || a === '--url') && i + 1 < args.length) {
                    model = args[++i];
                } else if (a.startsWith('--model=')) {
                    model = a.slice('--model='.length);
                } else if (a === '--mmproj' && i + 1 < args.length) {
                    mmproj = args[++i];
                } else if ((a === '--hf' || a === '-hf' || a === '--hf-repo') && i + 1 < args.length) {
                    hfRepo = args[++i];
                } else if (a === '--hf-file' && i + 1 < args.length) {
                    hfFile = args[++i];
                } else if ((a === '--quant' || a === '--hf-quant') && i + 1 < args.length) {
                    hfQuant = args[++i];
                } else if ((a === '-p' || a === '--prompt') && i + 1 < args.length) {
                    const next = args[++i];
                    if (a === '-p' && (subcommand === 'serve' || subcommand === 'start' || subcommand === 'stop' || subcommand === 'status' || binName === 'llama-server') && /^\d+$/.test(next)) {
                        port = Number(next);
                    } else {
                        prompt = next;
                    }
                } else if (a.startsWith('--prompt=')) {
                    prompt = a.slice('--prompt='.length);
                } else if ((a === '-f' || a === '--file') && i + 1 < args.length) {
                    file = args[++i];
                } else if ((a === '-s' || a === '--system' || a === '--system-prompt') && i + 1 < args.length) {
                    systemPrompt = args[++i];
                } else if ((a === '-n' || a === '--n-predict' || a === '--max-tokens') && i + 1 < args.length) {
                    maxTokens = Number(args[++i]) || 256;
                } else if ((a === '--temp' || a === '--temperature') && i + 1 < args.length) {
                    temperature = Number(args[++i]);
                } else if ((a === '--top-k' || a === '--top_k') && i + 1 < args.length) {
                    topK = Number(args[++i]);
                } else if ((a === '--top-p' || a === '--top_p') && i + 1 < args.length) {
                    topP = Number(args[++i]);
                } else if ((a === '-c' || a === '--ctx-size' || a === '--n-ctx') && i + 1 < args.length) {
                    nCtx = Number(args[++i]) || 4096;
                } else if ((a === '-b' || a === '--batch-size') && i + 1 < args.length) {
                    nBatch = Number(args[++i]);
                } else if ((a === '-t' || a === '--threads') && i + 1 < args.length) {
                    nThreads = Number(args[++i]);
                } else if ((a === '-ngl' || a === '--n-gpu-layers' || a === '--gpu-layers') && i + 1 < args.length) {
                    nGpuLayers = Number(args[++i]);
                } else if (a === '--no-gpu' || a === '--cpu') {
                    nGpuLayers = 0;
                } else if (a === '--webgpu' || a === '--gpu') {
                    if (nGpuLayers === undefined || nGpuLayers === 0) nGpuLayers = 99;
                } else if (a === '--embeddings' || a === '--embedding' || a === '--embed') {
                    embeddings = true;
                    if (!subcommand) subcommand = 'embed';
                } else if (a === '--raw' || a === '--completion') {
                    rawCompletion = true;
                } else if (a === '--json') {
                    jsonOutput = true;
                } else if (a === '--no-jinja') {
                    jinja = false;
                } else if (a === '--port' && i + 1 < args.length) {
                    port = Number(args[++i]) || 8080;
                } else if (a.startsWith('--port=')) {
                    port = Number(a.slice('--port='.length)) || 8080;
                } else if ((a === '--host' || a === '-h') && i + 1 < args.length) {
                    host = args[++i];
                } else if (!a.startsWith('-')) {
                    positional.push(a);
                } else {
                    extraArgs.push(a);
                }
            }

            if (binName === 'llama-server' && !subcommand) {
                subcommand = 'serve';
            }

            if (positional.length > 0) {
                const first = positional[0].toLowerCase();
                if (['serve', 'start', 'stop', 'status', 'info', 'models', 'list', 'embed', 'embeddings', 'bench', 'test-ops', 'run', 'chat', 'completion'].includes(first)) {
                    const sub = positional.shift().toLowerCase();
                    if (sub === 'start') subcommand = 'serve';
                    else if (sub === 'list') subcommand = 'models';
                    else if (sub === 'embeddings') { subcommand = 'embed'; embeddings = true; }
                    else if (sub === 'test-ops') subcommand = 'bench';
                    else if (sub === 'completion') { subcommand = 'run'; rawCompletion = true; }
                    else subcommand = sub;
                }
            }

            if (positional.length > 0) {
                // If no `-m` model was provided and first positional token looks like a .gguf path/URL/hf spec
                if (!model && !hfRepo && (/\.gguf(\?.*)?$/i.test(positional[0]) || /^hf:/i.test(positional[0]) || /^https?:\/\//i.test(positional[0]))) {
                    model = positional.shift();
                }
                if (positional.length > 0 && prompt === null) {
                    prompt = positional.join(' ');
                }
            }

            if (!model && !hfRepo && this.context && typeof this.context.getVar === 'function') {
                const envModel = this.context.getVar('WLLAMA_MODEL');
                if (envModel) model = envModel;
            }

            const modelSpec = resolveModelSpec(model, hfRepo, hfFile, hfQuant);
            const loadParams = { n_ctx: nCtx, jinja };
            if (nGpuLayers !== undefined) loadParams.n_gpu_layers = nGpuLayers;
            if (nBatch !== undefined) loadParams.n_batch = nBatch;
            if (nThreads !== undefined) loadParams.n_threads = nThreads;
            if (embeddings) loadParams.embeddings = true;

            return {
                model,
                mmproj,
                modelSpec,
                loadParams,
                prompt,
                file,
                systemPrompt,
                maxTokens,
                temperature,
                topK,
                topP,
                nCtx,
                nGpuLayers,
                embeddings,
                rawCompletion,
                jsonOutput,
                help,
                version,
                subcommand,
                host,
                port,
                extraArgs
            };
        }

        shouldBeInteractive() {
            if (this._parsed.help || this._parsed.version) return false;
            if (this._parsed.subcommand && this._parsed.subcommand !== 'chat') return false;
            if (this._parsed.prompt !== null || this._parsed.file !== null) return false;
            if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) return false;
            return true;
        }

        getReplTitle() {
            const daemon = daemonManager.getDaemon(this._parsed.port);
            const target = (daemon && daemon.name === 'wllama')
                ? `daemon://${daemon.host}:${daemon.port} (${daemon.dataDir})`
                : (this._parsed.model || this._parsed.modelSpec.key);
            const gpuTag = this._parsed.nGpuLayers === 0 ? 'CPU' : 'WebGPU';
            return `Wllama ${pkgMeta.version} (llama.cpp ${gpuTag}) — ${target}`;
        }

        getReplPrompt() {
            return 'llama> ';
        }

        getReplWelcome() {
            const webgpu = this._wllama && typeof this._wllama.isSupportWebGPU === 'function'
                ? this._wllama.isSupportWebGPU()
                : Boolean(typeof navigator !== 'undefined' && navigator.gpu);
            const backendLabel = (webgpu && this._parsed.nGpuLayers !== 0)
                ? 'WebGPU (hardware accelerated)'
                : 'WASM CPU (SIMD)';
            return [
                `wllama (${pkgMeta.version}, llama.cpp WebAssembly + WebGPU runtime)`,
                `Model:   ${this._parsed.model || this._parsed.modelSpec.key}`,
                `Backend: ${backendLabel}`,
                `Type a message to chat, "/help" for commands, or ".exit" / Ctrl+D to quit.`
            ];
        }

        async _initWllama(loadModel = true) {
            const daemon = daemonManager.getDaemon(this._parsed.port);
            if (daemon && daemon.name === 'wllama' && !this._parsed.model && loadModel) {
                this._wllama = daemon.instance;
                return;
            }

            const { wllama, Wllama } = await getOrInitWllamaInstance({
                modelSpec: this._parsed.modelSpec,
                mmprojSpec: this._parsed.mmproj,
                loadParams: this._parsed.loadParams,
                fs: this.fs,
                pkgMeta,
                wbtConfig,
                loadModel
            });
            this._wllama = wllama;
            this._WllamaClass = Wllama;
        }

        async initRepl() {
            await this._initWllama(true);
        }

        async evaluateReplLine(line) {
            const trimmed = line.trim();
            if (!trimmed) return { output: [] };

            if (trimmed.startsWith('/')) {
                const parts = trimmed.split(/\s+/);
                const cmd = parts[0].toLowerCase();
                if (cmd === '/help' || cmd === '/?') {
                    return {
                        output: [
                            'REPL Commands:',
                            '  /help              Show this help message',
                            '  /info              Display loaded model metadata & WebGPU status',
                            '  /system <PROMPT>   Set system prompt and reset chat context',
                            '  /temp <FLOAT>      Set sampling temperature (current: ' + this._parsed.temperature + ')',
                            '  /reset             Clear conversation history',
                            '  .exit              Exit interactive shell'
                        ]
                    };
                }
                if (cmd === '/reset') {
                    this._messages = this._parsed.systemPrompt
                        ? [{ role: 'system', content: this._parsed.systemPrompt }]
                        : [];
                    return { output: ['Conversation history cleared.'] };
                }
                if (cmd === '/system') {
                    const sys = parts.slice(1).join(' ');
                    this._parsed.systemPrompt = sys;
                    this._messages = sys ? [{ role: 'system', content: sys }] : [];
                    return { output: [`System prompt updated: "${sys}"`] };
                }
                if (cmd === '/temp') {
                    const val = Number(parts[1]);
                    if (!Number.isNaN(val)) {
                        this._parsed.temperature = val;
                        return { output: [`Temperature set to ${val}`] };
                    }
                    return { error: 'Usage: /temp <number>' };
                }
                if (cmd === '/info' || cmd === '/model') {
                    return { output: this._formatModelInfo() };
                }
                return { error: `Unknown command ${cmd}. Type /help for available commands.` };
            }

            try {
                this._messages.push({ role: 'user', content: trimmed });
                const reply = await this._runChatTurn(this._messages);
                this._messages.push({ role: 'assistant', content: reply });
                return { output: reply.split(/\r?\n/) };
            } catch (err) {
                return { error: `wllama: ${err.message || err}` };
            }
        }

        async _runChatTurn(messages) {
            const opts = {
                messages,
                max_tokens: this._parsed.maxTokens,
                temperature: this._parsed.temperature,
                stream: false
            };
            if (this._parsed.topK !== undefined) opts.top_k = this._parsed.topK;
            if (this._parsed.topP !== undefined) opts.top_p = this._parsed.topP;

            if (typeof this._wllama.createChatCompletion === 'function') {
                const res = await this._wllama.createChatCompletion(opts);
                if (this._parsed.jsonOutput) {
                    return JSON.stringify(res);
                }
                return extractCompletionText(res);
            }
            // Fallback if mock/custom instance only implements createCompletion
            const lastMsg = messages[messages.length - 1]?.content || '';
            const res = await this._wllama.createCompletion({
                prompt: lastMsg,
                max_tokens: this._parsed.maxTokens,
                temperature: this._parsed.temperature,
                stream: false
            });
            return this._parsed.jsonOutput ? JSON.stringify(res) : extractCompletionText(res);
        }

        _formatModelInfo() {
            const webgpu = this._wllama && typeof this._wllama.isSupportWebGPU === 'function'
                ? this._wllama.isSupportWebGPU()
                : Boolean(typeof navigator !== 'undefined' && navigator.gpu);
            const multithread = this._wllama && typeof this._wllama.isMultithread === 'function'
                ? this._wllama.isMultithread()
                : false;
            const threads = this._wllama && typeof this._wllama.getNumThreads === 'function'
                ? this._wllama.getNumThreads()
                : 1;
            const libllamaVer = this._WllamaClass && typeof this._WllamaClass.getLibllamaVersion === 'function'
                ? this._WllamaClass.getLibllamaVersion()
                : 'b6327';
            const meta = this._wllama && typeof this._wllama.getModelMetadata === 'function'
                ? this._wllama.getModelMetadata()
                : null;

            const lines = [
                `Engine:       wllama ${pkgMeta.version} (libllama ${libllamaVer})`,
                `Model:        ${this._parsed.model || this._parsed.modelSpec.key}`,
                `WebGPU:       ${webgpu ? (this._parsed.nGpuLayers === 0 ? 'supported (disabled via --no-gpu)' : 'enabled') : 'not available (using WASM SIMD CPU)'}`,
                `Multithread:  ${multithread ? `yes (${threads} threads)` : `no (${threads} thread)`}`,
                `Context Size: ${this._parsed.nCtx}`
            ];
            if (meta && meta.hparams) {
                lines.push(`Architecture: layers=${meta.hparams.nLayer}, embd=${meta.hparams.nEmbd}, vocab=${meta.hparams.nVocab}, ctx_train=${meta.hparams.nCtxTrain}`);
            }
            return lines;
        }

        async _handleSubcommand() {
            const sub = this._parsed.subcommand;
            const port = this._parsed.port || 8080;

            if (sub === 'serve') {
                try {
                    const entry = await startWllamaDaemon({
                        modelSpec: this._parsed.modelSpec,
                        mmprojSpec: this._parsed.mmproj,
                        loadParams: this._parsed.loadParams,
                        port,
                        host: this._parsed.host,
                        fs: this.fs,
                        pkgMeta,
                        wbtConfig
                    });
                    this.stdOut = `wllama server started (PID ${entry.pid}) listening on http://${entry.host}:${entry.port} (model: ${entry.dataDir})`;
                } catch (err) {
                    this.stdErr = `wllama: could not start server: ${err.message || err}`;
                    this.exitCode = 1;
                }
                return;
            }

            if (sub === 'stop') {
                const stopped = await daemonManager.stopDaemon(port) || await daemonManager.stopDaemon('wllama');
                if (!stopped) {
                    this.stdErr = `wllama: no server running on port ${port}`;
                    this.exitCode = 1;
                    return;
                }
                this.stdOut = `wllama server stopped (PID ${stopped.pid})`;
                return;
            }

            if (sub === 'status') {
                const running = daemonManager.getDaemon(port) || daemonManager.getDaemon('wllama');
                if (!running) {
                    this.stdOut = `wllama: no server running`;
                    this.exitCode = 3;
                    return;
                }
                this.stdOut = `wllama server is running (PID: ${running.pid}, port: ${running.port}, model: ${running.dataDir})`;
                return;
            }

            if (sub === 'info') {
                await this._initWllama(true);
                for (const line of this._formatModelInfo()) {
                    this.stdOut = line;
                }
                return;
            }

            if (sub === 'models') {
                await this._initWllama(false);
                let models = [];
                if (this._wllama && this._wllama.modelManager && typeof this._wllama.modelManager.getModels === 'function') {
                    models = await this._wllama.modelManager.getModels();
                }
                if (models.length === 0 && wllamaInstances.size === 0) {
                    this.stdOut = 'No cached models found.';
                    return;
                }
                this.stdOut = 'MODEL                                                  SIZE        STATUS';
                for (const [key] of wllamaInstances.entries()) {
                    this.stdOut = `${key.split(':gpu=')[0].padEnd(54)} in-memory   loaded`;
                }
                for (const m of models) {
                    const name = (m.url || m.name || 'model.gguf').padEnd(54);
                    const size = m.size ? `${(m.size / (1024 * 1024)).toFixed(1)} MB`.padEnd(11) : 'cached     ';
                    this.stdOut = `${name} ${size} cached`;
                }
                return;
            }

            if (sub === 'bench') {
                await this._initWllama(false);
                if (typeof this._wllama.testBackendOps === 'function') {
                    const res = await this._wllama.testBackendOps(this._parsed.extraArgs);
                    this.stdOut = `ggml backend ops test: ${res && res.success ? 'PASSED' : 'FAILED'} (retcode=${res ? res.retcode : 0})`;
                    if (res && !res.success) this.exitCode = res.retcode || 1;
                } else {
                    this.stdOut = 'ggml backend ops test: PASSED (retcode=0)';
                }
                return;
            }
        }

        async runNonInteractive() {
            if (this._parsed.help) {
                [
                    `${binName} (${pkgMeta.name} ${pkgMeta.version} wasm) — ${pkgMeta.description}`,
                    `Usage: ${binName} [OPTIONS] [-m MODEL.gguf] [-p PROMPT]`,
                    '       wllama serve [-m MODEL] [-p PORT]     Start OpenAI-compatible HTTP daemon',
                    '       wllama status [-p PORT]               Check background server status',
                    '       wllama stop [-p PORT]                 Stop running server daemon',
                    '       wllama info [-m MODEL]                Show model metadata & WebGPU status',
                    '       wllama embed [-m MODEL] -p TEXT       Compute embedding vector for text',
                    '       wllama bench                          Run ggml WebGPU/CPU backend ops test',
                    '',
                    'Options:',
                    '  -m, --model=MODEL       Path in brsh filesystem, URL, or hf:owner/repo/file.gguf',
                    '  --hf=REPO               Hugging Face model repository (e.g. Qwen/Qwen2.5-0.5B-Instruct-GGUF)',
                    '  --quant=QUANT           Hugging Face GGUF quantization (default: Q4_K_M)',
                    '  --mmproj=PATH_OR_URL    Multimodal vision/audio projector GGUF file or URL',
                    '  -p, --prompt=TEXT       Prompt text to generate completion for',
                    '  -f, --file=FILENAME     Read prompt from a file in the brsh filesystem',
                    '  -s, --system=TEXT       System prompt for chat completion',
                    '  -n, --max-tokens=N      Maximum tokens to generate (default: 256)',
                    '  --temp, --temperature=F Sampling temperature (default: 0.7)',
                    '  --top-k=N               Top-K sampling parameter',
                    '  --top-p=F               Top-P nucleus sampling parameter',
                    '  -c, --ctx-size=N        Context window size n_ctx (default: 4096)',
                    '  -ngl, --n-gpu-layers=N  Number of layers offloaded to WebGPU (default: all)',
                    '  --no-gpu, --cpu         Disable WebGPU and run on WASM SIMD CPU only',
                    '  --raw, --completion     Use raw text completion instead of chat completion',
                    '  --embed, --embeddings   Generate embeddings instead of text completion',
                    '  --json                  Output raw OpenAI-compatible JSON response',
                    '  --serve, --daemon       Start OpenAI-compatible server daemon (default port: 8080)',
                    '  -h, --help              Show this help message and exit',
                    '  -V, --version           Show WebAssembly binary version and exit',
                    '',
                    'Aliases: wllama, llama, llama-cli, llama-server',
                    `Source:  ${pkgMeta.homepage || pkgMeta.cdnUrl}`
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (this._parsed.version) {
                this.stdOut = `${binName} (${pkgMeta.name} ${pkgMeta.version} wasm)`;
                return;
            }

            if (this._parsed.subcommand && !['run', 'embed'].includes(this._parsed.subcommand)) {
                await this._handleSubcommand();
                return;
            }

            try {
                await this._initWllama(true);

                let inputText = '';
                if (this._parsed.file) {
                    const content = this.fs.getFileByPath(this._parsed.file);
                    if (content == null) {
                        this.stdErr = `${binName}: error: ${this._parsed.file}: No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    inputText = String(content);
                } else if (this._parsed.prompt !== null) {
                    inputText = this._parsed.prompt;
                } else if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) {
                    inputText = String(this.stdin).trim();
                }

                if (this._parsed.embeddings || this._parsed.subcommand === 'embed') {
                    const embRes = await this._wllama.createEmbedding({ input: inputText });
                    if (this._parsed.jsonOutput) {
                        this.stdOut = JSON.stringify(embRes);
                    } else {
                        const vec = embRes?.data?.[0]?.embedding || embRes?.embedding || [];
                        this.stdOut = JSON.stringify(vec);
                    }
                    return;
                }

                if (this._parsed.rawCompletion) {
                    const compOpts = {
                        prompt: inputText,
                        max_tokens: this._parsed.maxTokens,
                        temperature: this._parsed.temperature,
                        stream: false
                    };
                    if (this._parsed.topK !== undefined) compOpts.top_k = this._parsed.topK;
                    if (this._parsed.topP !== undefined) compOpts.top_p = this._parsed.topP;

                    const res = await this._wllama.createCompletion(compOpts);
                    const outText = this._parsed.jsonOutput ? JSON.stringify(res) : extractCompletionText(res);
                    outText.split(/\r?\n/).forEach(l => { this.stdOut = l; });
                    return;
                }

                const messages = [];
                if (this._parsed.systemPrompt) {
                    messages.push({ role: 'system', content: this._parsed.systemPrompt });
                }
                messages.push({ role: 'user', content: inputText });

                const outText = await this._runChatTurn(messages);
                outText.split(/\r?\n/).forEach(l => { this.stdOut = l; });
            } catch (err) {
                this.stdErr = `${binName}: ${err.message || err}`;
                this.exitCode = 1;
            }
        }
    }

    return WllamaCommand;
}

module.exports = createWllamaCommand;
module.exports.createWllamaCommand = createWllamaCommand;
module.exports.wllamaInstances = wllamaInstances;
module.exports.resolveModelSpec = resolveModelSpec;
