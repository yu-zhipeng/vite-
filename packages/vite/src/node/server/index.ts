import path from 'node:path'
import type * as net from 'node:net'
import type * as http from 'node:http'
import { performance } from 'node:perf_hooks'
import connect from 'connect'
import corsMiddleware from 'cors'
import colors from 'picocolors'
import chokidar from 'chokidar'
import type { FSWatcher, WatchOptions } from 'dep-types/chokidar'
import type { Connect } from 'dep-types/connect'
import launchEditorMiddleware from 'launch-editor-middleware'
import type { SourceMap } from 'rollup'
import picomatch from 'picomatch'
import type { Matcher } from 'picomatch'
import type { InvalidatePayload } from 'types/customEvent'
import type { CommonServerOptions } from '../http'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from '../http'
import type { InlineConfig, ResolvedConfig } from '../config'
import { isDepsOptimizerEnabled, resolveConfig } from '../config'
import {
  isParentDirectory,
  mergeConfig,
  normalizePath,
  resolveHostname,
  resolveServerUrls,
} from '../utils'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { cjsSsrResolveExternals } from '../ssr/ssrExternal'
import { ssrFixStacktrace, ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import {
  getDepsOptimizer,
  initDepsOptimizer,
  initDevSsrDepsOptimizer,
} from '../optimizer'
import { bindShortcuts } from '../shortcuts'
import type { BindShortcutsOptions } from '../shortcuts'
import { CLIENT_DIR } from '../constants'
import type { Logger } from '../logger'
import { printServerUrls } from '../logger'
import { invalidatePackageData } from '../packages'
import { resolveChokidarOptions } from '../watch'
import type { PluginContainer } from './pluginContainer'
import { createPluginContainer } from './pluginContainer'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware } from './middlewares/proxy'
import { htmlFallbackMiddleware } from './middlewares/htmlFallback'
import { transformMiddleware } from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from './middlewares/indexHtml'
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import type { ModuleNode } from './moduleGraph'
import { ModuleGraph } from './moduleGraph'
import { errorMiddleware, prepareError } from './middlewares/error'
import type { HmrOptions } from './hmr'
import {
  getShortName,
  handleFileAddUnlink,
  handleHMRUpdate,
  updateModules,
} from './hmr'
import { openBrowser } from './openBrowser'
import type { TransformOptions, TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import { searchForWorkspaceRoot } from './searchRoot'

export { searchForWorkspaceRoot } from './searchRoot'

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * chokidar watch options
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   */
  middlewareMode?: boolean | 'html' | 'ssr'
  /**
   * Prepend this folder to http requests, for use when proxying vite as a subfolder
   * Should start and end with the `/` character
   */
  base?: string
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   *
   * @example `http://127.0.0.1:8080`
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   * @default true
   */
  preTransformRequests?: boolean
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   *
   * @deprecated Use optimizeDeps.force instead, this option may be removed
   * in a future minor version without following semver
   */
  force?: boolean
}

export interface ResolvedServerOptions extends ServerOptions {
  fs: Required<FileSystemServeOptions>
  middlewareMode: boolean
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.crt', '*.pem']
   */
  deny?: string[]
}

export type ServerHook = (
  this: void,
  server: ViteDevServer,
) => (() => void) | void | Promise<(() => void) | void>

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: http.Server | null
  /**
   * chokidar watcher instance
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher
  /**
   * web socket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI. null in middleware mode or
   * before `server.listen` is called.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions,
  ): Promise<TransformResult | null>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string>
  /**
   * Transform module code into SSR format.
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | null,
    url: string,
    originalCode?: string,
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean },
  ): Promise<Record<string, any>>
  /**
   * Returns a fixed version of the given stack
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Triggers HMR for a module in the module graph. You can use the `server.moduleGraph`
   * API to retrieve the module to be reloaded. If `hmr` is false, this is a no-op.
   */
  reloadModule(module: ModuleNode): Promise<void>
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>
  /**
   * @internal
   */
  _importGlobMap: Map<string, string[][]>
  /**
   * Deps that are externalized
   * @internal
   */
  _ssrExternals: string[] | null
  /**
   * @internal
   */
  _restartPromise: Promise<void> | null
  /**
   * @internal
   */
  _forceOptimizeOnRestart: boolean
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _fsDenyGlob: Matcher
  /**
   * @internal
   * Actually BindShortcutsOptions | undefined but api-extractor checks for
   * export before trimming internal types :(
   * And I don't want to add complexity to prePatchTypes for that
   */
  _shortcutsOptions: any | undefined
}

export interface ResolvedServerUrls {
  local: string[]
  network: string[]
}

export async function createServer(
  inlineConfig: InlineConfig = {},
): Promise<ViteDevServer> {
  // Vite 配置整合
  // 将命令行配置和vite默认配置进行合并
  // 默认command是serve
  // 初始化配置文件config，其中包含了插件的初始化的过程，包含过滤插件、排序插件。还会执行插件的 config 钩子，深度合并 config
  const config = await resolveConfig(inlineConfig, 'serve')
  const { root, server: serverConfig } = config
  // https配置
  const httpsOptions = await resolveHttpsConfig(config.server.https)
  // 以中间件模式创建 Vite 服务器 分为两种类型 'ssr' | 'html'
  // 'ssr' 将禁用 Vite 自身的 HTML 服务逻辑，因此你应该手动为 index.html 提供服务
  // 'html' 将启用 Vite 自身的 HTML 服务逻辑
  const { middlewareMode } = serverConfig
  // 文件变动监测Chokidar的配置
  // 默认忽略.git、node_modules、test-results、.vite下的文件监测，因为这些文件通常不会变动
  const resolvedWatchOptions = resolveChokidarOptions(config, {
    disableGlobbing: true,
    ...serverConfig.watch,
  })
  // vite 对中间件模式的依赖逐渐变小，而采用了更合适的connect
  // express中间件系统就是基于connect
  // connect启动中间件服务
  // 中间件的目的在于能够在服务中灵活的处理不同的类型的任务
  // 当一个请求发送到 server 时，会经过一个个的中间件，中间件本质是一个回调函数，每次请求都会执行回调
  // connect 的中间件机制有如下特点：1，每个中间件可以分别对请求进行处理，并进行响应 2，每个中间件可以只处理特定的事情，其他事情交给其他中间件处理
  // 3，可以调用 next 函数，将请求传递给下一个中间件。如果不调用，则之后的中间件都不会被执行
  const middlewares = connect() as Connect.Server
  // 创建一个http服务
  // 会根据 config.server 的配置创建 http/https 服务器，并将 request 交由 middlewares 来处理
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions)
  // 创建websocket服务，用于浏览器的热更新
  const ws = createWebSocketServer(httpServer, config, httpsOptions)

  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger)
  }
  // 启动文件监听
  const watcher = chokidar.watch(
    path.resolve(root),
    resolvedWatchOptions,
  ) as FSWatcher
  // 创建模块图谱，用来记录每个模块之间的依赖关系
  // 主要的用途在于，在热更新时，当某个js更新时，Modulereplacement就能通知与之关联的文件进行更新相关的逻辑
  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr }),
  )
  // 创建插件容器
  // 其中比较重要的钩子：buildStart、resolveId、load、transform 这些都是rollup的钩子
  const container = await createPluginContainer(config, moduleGraph, watcher)
  // 服务关闭的钩子
  const closeHttpServer = createServerCloseFn(httpServer)

  let exitProcess: () => void
  // 定义server对象
  const server: ViteDevServer = {
    config,
    middlewares,
    httpServer,
    watcher,
    pluginContainer: container,
    ws,
    moduleGraph,
    resolvedUrls: null, // will be set on listen
    ssrTransform(
      code: string,
      inMap: SourceMap | null,
      url: string,
      originalCode = code,
    ) {
      return ssrTransform(code, inMap, url, originalCode, server.config)
    },
    transformRequest(url, options) {
      return transformRequest(url, server, options)
    },
    transformIndexHtml: null!, // to be immediately set
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      if (isDepsOptimizerEnabled(config, true)) {
        await initDevSsrDepsOptimizer(config, server)
      }
      await updateCjsSsrExternals(server)
      return ssrLoadModule(
        url,
        server,
        undefined,
        undefined,
        opts?.fixStacktrace,
      )
    },
    ssrFixStacktrace(e) {
      ssrFixStacktrace(e, moduleGraph)
    },
    ssrRewriteStacktrace(stack: string) {
      return ssrRewriteStacktrace(stack, moduleGraph)
    },
    async reloadModule(module) {
      if (serverConfig.hmr !== false && module.file) {
        updateModules(module.file, [module], Date.now(), server)
      }
    },
    // 监听
    async listen(port?: number, isRestart?: boolean) {
      // 启动服务，端口号默认5173
      await startServer(server, port, isRestart)
      // 服务启动完成，获取服务地址
      if (httpServer) {
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config,
        )
      }
      return server
    },
    async close() {
      if (!middlewareMode) {
        process.off('SIGTERM', exitProcess)
        if (process.env.CI !== 'true') {
          process.stdin.off('end', exitProcess)
        }
      }
      await Promise.allSettled([
        watcher.close(),
        ws.close(),
        // 服务关闭时，也执行插件的close钩子
        container.close(),
        getDepsOptimizer(server.config)?.close(),
        getDepsOptimizer(server.config, true)?.close(),
        closeHttpServer(),
      ])
      server.resolvedUrls = null
    },
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info,
        )
      } else if (middlewareMode) {
        throw new Error('cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'cannot print server URLs before server.listen is called.',
        )
      }
    },
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },

    _ssrExternals: null,
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
    _fsDenyGlob: picomatch(config.server.fs.deny, { matchBase: true }),
    _shortcutsOptions: undefined,
  }

  // 为SSR添加ViteDevServer.TransIndexHtml方法
  server.transformIndexHtml = createDevHtmlTransformFn(server)

  if (!middlewareMode) {
    // 进程退出的时候，执行的函数
    exitProcess = async () => {
      try {
        await server.close()
      } finally {
        process.exit()
      }
    }
    // 进程得到SIGTERM的信号，就会执行exitProcess
    process.once('SIGTERM', exitProcess)
    if (process.env.CI !== 'true') {
      process.stdin.on('end', exitProcess)
    }
  }

  const { packageCache } = config
  // 存储原始的set方法
  const setPackageData = packageCache.set.bind(packageCache)
  // 重写set方法
  packageCache.set = (id, pkg) => {
    // 当缓存是json文件时，加入对它的监听
    if (id.endsWith('.json')) {
      watcher.add(id)
    }
    return setPackageData(id, pkg)
  }
  // 当监听到文件变动时
  watcher.on('change', async (file) => {
    debugger
    // 获取文件路径
    file = normalizePath(file)
    // 如果是package.json变动，则需要清空缓存
    if (file.endsWith('/package.json')) {
      return invalidatePackageData(packageCache, file)
    }
    // invalidate module graph cache on file change
    // 文件改变时，让modulegraph失效
    moduleGraph.onFileChange(file)
    // 如果开启了热更新
    if (serverConfig.hmr !== false) {
      try {
        //处理hmr更新
        await handleHMRUpdate(file, server)
      } catch (err) {
        // 在文件变化时，如果热更新关闭时，需要报错
        ws.send({
          type: 'error',
          err: prepareError(err),
        })
      }
    }
  })
  // 当监听到文件新增时
  watcher.on('add', (file) => {
    // 会从file里面获得模块，包含需要域解析的import.meta.glob的模块，执行updateModules，ws会向客户端发送更新请求，客户端发送http请求最新的模块
    handleFileAddUnlink(normalizePath(file), server)
  })
  // 当监听到文件删除时
  watcher.on('unlink', (file) => {
    handleFileAddUnlink(normalizePath(file), server)
  })
  // websocket监听
  // 通过调用 import.meta.hot.invalidate()，HMR 服务将使调用方的导入失效，就像调用方不是接收自身的一样
  // 就是使该模块的热更新失效，强制使用浏览器刷新
  ws.on('vite:invalidate', async ({ path, message }: InvalidatePayload) => {
    const mod = moduleGraph.urlToModuleMap.get(path)
    if (mod && mod.isSelfAccepting && mod.lastHMRTimestamp > 0) {
      config.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(path) +
          (message ? ` ${message}` : ''),
        { timestamp: true },
      )
      const file = getShortName(mod.file!, config.root)
      updateModules(
        file,
        [...mod.importers],
        mod.lastHMRTimestamp,
        server,
        true,
      )
    }
  })

  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      // 更新端口号，这里只监听一次
      // 因为如果存在端口号占用，与配置不符合，这里会获取真正的使用的端口号
      serverConfig.port = (httpServer.address() as net.AddressInfo).port
    })
  }

  // apply server configuration hooks from plugins
  // 应用插件的服务配置钩子
  const postHooks: ((() => void) | void)[] = []
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    // vite:import-analysis
    postHooks.push(await hook(server))
  }

  // Internal middlewares ------------------------------------------------------

  // request timer
  // 进入debug模式，会使用timeMiddleware
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }

  // cors (enabled by default)
  // vite支持配置开发服务器的CORS，默认启用并允许任何源
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // proxy
  // 处理代理配置的中间件
  // vite支持为开发服务器配置自定义代理规则
  const { proxy } = serverConfig
  if (proxy) {
    middlewares.use(proxyMiddleware(httpServer, proxy, config))
  }

  // base
  // 处理 base url 的中间件
  // 在 HTTP 请求中预留此文件夹，用于代理 Vite 作为子文件夹时使用
  if (config.base !== '/') {
    middlewares.use(baseMiddleware(server))
  }

  // open in editor support
  // 打开编辑器的中间件
  // 对应库：https://github.com/yyx990803/launch-editor#readme
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  // 处理 public 下文件的中间件
  if (config.publicDir) {
    middlewares.use(
      servePublicMiddleware(config.publicDir, config.server.headers),
    )
  }

  // main transform middleware
  // 核心内容转换中间件
  // 这个 middleware 是与浏览器请求模块相关的
  // 当我们访问localhost:5173/时，首先被transformMiddleware拦截
  // 当js文件里面存在import的时候，我们就需要将import的模块通过http请求拉取到客户端
  // transformMiddleware就是解析引入模块，并关联真实模块的地址
  middlewares.use(transformMiddleware(server))

  // serve static files
  // 文件处理中间件
  middlewares.use(serveRawFsMiddleware(server))
  middlewares.use(serveStaticMiddleware(root, server))

  // html fallback
  if (config.appType === 'spa' || config.appType === 'mpa') {
    // connect-history-api-fallback 是一个用于支持SPA History路由模式的 nodejs 库
    // 它的作用是当页面访问出现错误时重定向到 index.html 页面，既重新访问index.html
    // 使用connect-history-api-fallback将404的html请求重定向到index.html
    middlewares.use(htmlFallbackMiddleware(root, config.appType === 'spa'))
  }

  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  // 这是在html中间件之前应用的，以便用户中间件可以提供自定义内容，而不是index.html
  // 上面的中间件是vite的核心的中间件，而有一些用户新增的中间件希望在这些之后运行
  // 这意味着执行靠后，权重更大
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // transform index.html
    // 处理 index.html 的中间件
    // vite会通过这个插件钩子，对index.html进行修改，可以插入任何的内容，直接修改 html 代码
    // 比如热更新代码，在 <head> 标签内的最前面，拼接上 <script src="/@vite/client" type="module"></script>
    middlewares.use(indexHtmlMiddleware(server))

    // handle 404s
    // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
    // 上面都不好使时 404
    middlewares.use(function vite404Middleware(_, res) {
      res.statusCode = 404
      res.end()
    })
  }

  // error handler
  // 错误处理中间件
  middlewares.use(errorMiddleware(server, middlewareMode))

  let initingServer: Promise<void> | undefined
  let serverInited = false
  const initServer = async () => {
    if (serverInited) {
      return
    }
    if (initingServer) {
      return initingServer
    }
    initingServer = (async function () {
      // 构建开始，运行插件的钩子函数
      await container.buildStart({})
      if (isDepsOptimizerEnabled(config, false)) {
        // non-ssr
        // optimize: 预构建
        await initDepsOptimizer(config, server)
      }
      initingServer = undefined
      serverInited = true
    })()
    return initingServer
  }

  if (!middlewareMode && httpServer) {
    // overwrite listen to init optimizer before server start
    // 监听端口，启动服务
    // 这里重写了原有node的listen方法，在服务真正启动之前先进行依赖预构建
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        await initServer()
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args)
    }) as any
  } else {
    await initServer()
  }

  return server
}

async function startServer(
  server: ViteDevServer,
  inlinePort?: number,
  isRestart: boolean = false,
): Promise<void> {
  const httpServer = server.httpServer
  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server
  const port = inlinePort ?? options.port ?? 5173
  // 解析host地址，并不是localhost就是对应的127.0.0.1
  const hostname = await resolveHostname(options.host)

  const protocol = options.https ? 'https' : 'http'
  // 
  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger,
  })

  if (options.open && !isRestart) {
    const path =
      typeof options.open === 'string' ? options.open : server.config.base
    openBrowser(
      path.startsWith('http')
        ? path
        : new URL(path, `${protocol}://${hostname.name}:${serverPort}`).href,
      true,
      server.config.logger,
    )
  }
}

function createServerCloseFn(server: http.Server | null) {
  if (!server) {
    return () => {}
  }

  let hasListened = false
  const openSockets = new Set<net.Socket>()

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  server.once('listening', () => {
    hasListened = true
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy())
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

export function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger,
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as ResolvedServerOptions),
    middlewareMode: !!raw?.middlewareMode,
  }
  let allowDirs = server.fs?.allow
  const deny = server.fs?.deny || ['.env', '.env.*', '*.{crt,pem}']

  if (!allowDirs) {
    allowDirs = [searchForWorkspaceRoot(root)]
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny,
  }

  if (server.origin?.endsWith('/')) {
    server.origin = server.origin.slice(0, -1)
    logger.warn(
      colors.yellow(
        `${colors.bold('(!)')} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`,
      ),
    )
  }

  return server
}

async function restartServer(server: ViteDevServer) {
  global.__vite_start_time = performance.now()
  const { port: prevPort, host: prevHost } = server.config.server
  const shortcutsOptions: BindShortcutsOptions = server._shortcutsOptions

  await server.close()

  let inlineConfig = server.config.inlineConfig
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      optimizeDeps: {
        force: true,
      },
    })
  }

  let newServer = null
  try {
    newServer = await createServer(inlineConfig)
  } catch (err: any) {
    server.config.logger.error(err.message, {
      timestamp: true,
    })
    return
  }

  // prevent new server `restart` function from calling
  newServer._restartPromise = server._restartPromise

  Object.assign(server, newServer)

  const {
    logger,
    server: { port, host, middlewareMode },
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
    logger.info('server restarted.', { timestamp: true })
    if ((port ?? 5173) !== (prevPort ?? 5173) || host !== prevHost) {
      logger.info('')
      server.printUrls()
    }
  } else {
    logger.info('server restarted.', { timestamp: true })
  }

  if (shortcutsOptions) {
    shortcutsOptions.print = false
    bindShortcuts(newServer, shortcutsOptions)
  }

  // new server (the current server) can restart now
  newServer._restartPromise = null
}

async function updateCjsSsrExternals(server: ViteDevServer) {
  if (!server._ssrExternals) {
    let knownImports: string[] = []

    // Important! We use the non-ssr optimized deps to find known imports
    // Only the explicitly defined deps are optimized during dev SSR, so
    // we use the generated list from the scanned deps in regular dev.
    // This is part of the v2 externalization heuristics and it is kept
    // for backwards compatibility in case user needs to fallback to the
    // legacy scheme. It may be removed in a future v3 minor.
    const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr

    if (depsOptimizer) {
      await depsOptimizer.scanProcessing
      knownImports = [
        ...Object.keys(depsOptimizer.metadata.optimized),
        ...Object.keys(depsOptimizer.metadata.discovered),
      ]
    }
    server._ssrExternals = cjsSsrResolveExternals(server.config, knownImports)
  }
}
