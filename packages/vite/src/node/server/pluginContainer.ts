/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { VERSION as rollupVersion } from 'rollup'
import type {
  AsyncPluginHooks,
  CustomPluginOptions,
  EmittedFile,
  FunctionPluginHooks,
  InputOptions,
  LoadResult,
  MinimalPluginContext,
  ModuleInfo,
  NormalizedInputOptions,
  OutputOptions,
  ParallelPluginHooks,
  PartialResolvedId,
  ResolvedId,
  RollupError,
  PluginContext as RollupPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult,
} from 'rollup'
import * as acorn from 'acorn'
import type { RawSourceMap } from '@ampproject/remapping'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import type { FSWatcher } from 'chokidar'
import colors from 'picocolors'
import type * as postcss from 'postcss'
import type { Plugin } from '../plugin'
import {
  arraify,
  cleanUrl,
  combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  numberToPos,
  prettifyUrl,
  timeFrom,
} from '../utils'
import { FS_PREFIX } from '../constants'
import type { ResolvedConfig } from '../config'
import { createPluginHookUtils } from '../plugins'
import { buildErrorMessage } from './middlewares/error'
import type { ModuleGraph } from './moduleGraph'

export interface PluginContainerOptions {
  cwd?: string
  output?: OutputOptions
  modules?: Map<string, { info: ModuleInfo }>
  writeFile?: (name: string, source: string | Uint8Array) => void
}

export interface PluginContainer {
  options: InputOptions
  getModuleInfo(id: string): ModuleInfo | null
  buildStart(options: InputOptions): Promise<void>
  resolveId(
    id: string,
    importer?: string,
    options?: {
      assertions?: Record<string, string>
      custom?: CustomPluginOptions
      skip?: Set<Plugin>
      ssr?: boolean
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null>
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription['map']
      ssr?: boolean
    },
  ): Promise<SourceDescription | null>
  load(
    id: string,
    options?: {
      ssr?: boolean
    },
  ): Promise<LoadResult | null>
  close(): Promise<void>
}
// Omit忽略掉不支持的属性
type PluginContext = Omit<
  RollupPluginContext,
  // not supported
  | 'load'
  // not documented
  | 'cache'
  // deprecated
  | 'moduleIds'
>

export let parser = acorn.Parser

// 调用发生在服务启动时，在createServer函数中pluginContainer
export async function createPluginContainer(
  config: ResolvedConfig,
  moduleGraph?: ModuleGraph,
  watcher?: FSWatcher,// watcher是chokidar的实例
): Promise<PluginContainer> {
  const isDebug = process.env.DEBUG
  const {
    plugins,
    logger,
    root,
    build: { rollupOptions },
  } = config
  const { getSortedPluginHooks, getSortedPlugins } =
    createPluginHookUtils(plugins)

  const seenResolves: Record<string, true | undefined> = {}
  const debugResolve = createDebugger('vite:resolve')
  const debugPluginResolve = createDebugger('vite:plugin-resolve', {
    onlyWhenFocused: 'vite:plugin',
  })
  const debugPluginTransform = createDebugger('vite:plugin-transform', {
    onlyWhenFocused: 'vite:plugin',
  })
  const debugSourcemapCombineFlag = 'vite:sourcemap-combine'
  const isDebugSourcemapCombineFocused = process.env.DEBUG?.includes(
    debugSourcemapCombineFlag,
  )
  const debugSourcemapCombineFilter =
    process.env.DEBUG_VITE_SOURCEMAP_COMBINE_FILTER
  const debugSourcemapCombine = createDebugger('vite:sourcemap-combine', {
    onlyWhenFocused: true,
  })

  // ---------------------------------------------------------------------------

  const watchFiles = new Set<string>()

  const minimalContext: MinimalPluginContext = {
    meta: {
      rollupVersion,
      watchMode: true,
    },
  }

  function warnIncompatibleMethod(method: string, plugin: string) {
    logger.warn(
      colors.cyan(`[plugin:${plugin}] `) +
        colors.yellow(
          `context method ${colors.bold(
            `${method}()`,
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`,
        ),
    )
  }

  // parallel, ignores returns
  // 并行，忽略返回值
  async function hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>(
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>,
  ): Promise<void> {
    const parallelPromises: Promise<unknown>[] = []
    for (const plugin of getSortedPlugins(hookName)) {
      const hook = plugin[hookName]
      if (!hook) continue
      // @ts-expect-error hook is not a primitive
      const handler: Function = 'handler' in hook ? hook.handler : hook
      if ((hook as { sequential?: boolean }).sequential) {
        await Promise.all(parallelPromises)
        parallelPromises.length = 0
        await handler.apply(context(plugin), args(plugin))
      } else {
        parallelPromises.push(handler.apply(context(plugin), args(plugin)))
      }
    }
    await Promise.all(parallelPromises)
  }

  // throw when an unsupported ModuleInfo property is accessed,
  // so that incompatible plugins fail in a non-cryptic way.
  const ModuleInfoProxy: ProxyHandler<ModuleInfo> = {
    get(info: any, key: string) {
      if (key in info) {
        return info[key]
      }
      throw Error(
        `[vite] The "${key}" property of ModuleInfo is not supported.`,
      )
    },
  }

  // same default value of "moduleInfo.meta" as in Rollup
  const EMPTY_OBJECT = Object.freeze({})

  function getModuleInfo(id: string) {
    const module = moduleGraph?.getModuleById(id)
    if (!module) {
      return null
    }
    if (!module.info) {
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        ModuleInfoProxy,
      )
    }
    return module.info
  }

  function updateModuleInfo(id: string, { meta }: { meta?: object | null }) {
    if (meta) {
      const moduleInfo = getModuleInfo(id)
      if (moduleInfo) {
        moduleInfo.meta = { ...moduleInfo.meta, ...meta }
      }
    }
  }

  // we should create a new context for each async hook pipeline so that the
  // active plugin in that pipeline can be tracked in a concurrency-safe manner.
  // using a class to make creating new contexts more efficient
  // 定义一个 Context 类
  // Context实现了PluginContext，PluginContext是rollup的context
  // 所以这里就是rollup的context的vite的实现，
  // 因为rollup的插件系统，vite并不是所有的方法都支持，所以vite自己实现了context，对不支持的方法进行提示
  class Context implements PluginContext {
    meta = minimalContext.meta
    ssr = false
    _scan = false
    _activePlugin: Plugin | null
    _activeId: string | null = null
    _activeCode: string | null = null
    _resolveSkips?: Set<Plugin>
    _addedImports: Set<string> | null = null

    constructor(initialPlugin?: Plugin) {
      this._activePlugin = initialPlugin || null
    }
    // 编译代码的入口
    parse(code: string, opts: any = {}) {
      return parser.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
        ...opts,
      })
    }
    // 
    async resolve(
      id: string,
      importer?: string,
      options?: {
        assertions?: Record<string, string>
        custom?: CustomPluginOptions
        isEntry?: boolean
        skipSelf?: boolean
      },
    ) {
      let skip: Set<Plugin> | undefined
      if (options?.skipSelf && this._activePlugin) {
        skip = new Set(this._resolveSkips)
        skip.add(this._activePlugin)
      }
      let out = await container.resolveId(id, importer, {
        assertions: options?.assertions,
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        skip,
        ssr: this.ssr,
        scan: this._scan,
      })
      if (typeof out === 'string') out = { id: out }
      return out as ResolvedId | null
    }

    getModuleInfo(id: string) {
      return getModuleInfo(id)
    }

    getModuleIds() {
      return moduleGraph
        ? moduleGraph.idToModuleMap.keys()
        : Array.prototype[Symbol.iterator]()
    }

    addWatchFile(id: string) {
      watchFiles.add(id)
      ;(this._addedImports || (this._addedImports = new Set())).add(id)
      if (watcher) ensureWatchedFile(watcher, id, root)
    }

    getWatchFiles() {
      return [...watchFiles]
    }
    // rollup的某些钩子是不能在vite中使用的，会刨除警告
    emitFile(assetOrFile: EmittedFile) {
      warnIncompatibleMethod(`emitFile`, this._activePlugin!.name)
      return ''
    }
    // rollup的某些钩子是不能在vite中使用的，会刨除警告
    setAssetSource() {
      warnIncompatibleMethod(`setAssetSource`, this._activePlugin!.name)
    }
    // rollup的某些钩子是不能在vite中使用的，会刨除警告
    getFileName() {
      warnIncompatibleMethod(`getFileName`, this._activePlugin!.name)
      return ''
    }

    warn(
      e: string | RollupError,
      position?: number | { column: number; line: number },
    ) {
      const err = formatError(e, position, this)
      const msg = buildErrorMessage(
        err,
        [colors.yellow(`warning: ${err.message}`)],
        false,
      )
      logger.warn(msg, {
        clear: true,
        timestamp: true,
      })
    }

    error(
      e: string | RollupError,
      position?: number | { column: number; line: number },
    ): never {
      // error thrown here is caught by the transform middleware and passed on
      // the the error middleware.
      throw formatError(e, position, this)
    }
  }

  function formatError(
    e: string | RollupError,
    position: number | { column: number; line: number } | undefined,
    ctx: Context,
  ) {
    const err = (
      typeof e === 'string' ? new Error(e) : e
    ) as postcss.CssSyntaxError & RollupError
    if (err.pluginCode) {
      return err // The plugin likely called `this.error`
    }
    if (err.file && err.name === 'CssSyntaxError') {
      err.id = normalizePath(err.file)
    }
    if (ctx._activePlugin) err.plugin = ctx._activePlugin.name
    if (ctx._activeId && !err.id) err.id = ctx._activeId
    if (ctx._activeCode) {
      err.pluginCode = ctx._activeCode

      const pos =
        position != null
          ? position
          : err.pos != null
          ? err.pos
          : // some rollup plugins, e.g. json, sets position instead of pos
            (err as any).position

      if (pos != null) {
        let errLocation
        try {
          errLocation = numberToPos(ctx._activeCode, pos)
        } catch (err2) {
          logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`,
            ),
            // print extra newline to separate the two errors
            { error: err2 },
          )
          throw err
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        }
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = ctx._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        }
        err.frame = err.frame || generateCodeFrame(err.id!, err.loc)
      }

      if (err.loc && ctx instanceof TransformContext) {
        const rawSourceMap = ctx._getCombinedSourcemap()
        if (rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any)
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          })
          if (source && line != null && column != null) {
            err.loc = { file: source, line, column }
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file)
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
        }
        if (code) {
          err.frame = generateCodeFrame(code, err.loc)
        }
      }
    }
    return err
  }
  // 定义一个 TransformContext 类
  // 主要涉及到sourcemap
  class TransformContext extends Context {
    filename: string
    originalCode: string
    originalSourcemap: SourceMap | null = null
    sourcemapChain: NonNullable<SourceDescription['map']>[] = []
    combinedMap: SourceMap | null = null

    constructor(filename: string, code: string, inMap?: SourceMap | string) {
      super()
      this.filename = filename
      this.originalCode = code
      if (inMap) {
        if (isDebugSourcemapCombineFocused) {
          // @ts-expect-error inject name for debug purpose
          inMap.name = '$inMap'
        }
        this.sourcemapChain.push(inMap)
      }
    }

    _getCombinedSourcemap(createIfNull = false) {
      if (
        debugSourcemapCombineFilter &&
        this.filename.includes(debugSourcemapCombineFilter)
      ) {
        debugSourcemapCombine('----------', this.filename)
        debugSourcemapCombine(this.combinedMap)
        debugSourcemapCombine(this.sourcemapChain)
        debugSourcemapCombine('----------')
      }

      let combinedMap = this.combinedMap
      for (let m of this.sourcemapChain) {
        if (typeof m === 'string') m = JSON.parse(m)
        if (!('version' in (m as SourceMap))) {
          // empty, nullified source map
          combinedMap = this.combinedMap = null
          this.sourcemapChain.length = 0
          break
        }
        if (!combinedMap) {
          combinedMap = m as SourceMap
        } else {
          combinedMap = combineSourcemaps(cleanUrl(this.filename), [
            {
              ...(m as RawSourceMap),
              sourcesContent: combinedMap.sourcesContent,
            },
            combinedMap as RawSourceMap,
          ]) as SourceMap
        }
      }
      if (!combinedMap) {
        return createIfNull
          ? new MagicString(this.originalCode).generateMap({
              includeContent: true,
              hires: true,
              source: cleanUrl(this.filename),
            })
          : null
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap
        this.sourcemapChain.length = 0
      }
      return this.combinedMap
    }

    getCombinedSourcemap() {
      return this._getCombinedSourcemap(true) as SourceMap
    }
  }

  let closed = false
  // 创建容器对象，对象内属性就是 Vite 支持的 Rollup 钩子函数
  const container: PluginContainer = {
    // 注意这里是一个立即执行函数，在服务器启动时被调用
    options: await (async () => {
      let options = rollupOptions
      for (const optionsHook of getSortedPluginHooks('options')) {
        // 调用所有 vite 插件中定义的 options 钩子函数并传入配置中的 config.build.rollupOptions
        options = (await optionsHook.call(minimalContext, options)) || options
      }
      if (options.acornInjectPlugins) {
        // 扩展 acorn 解析器
        // acorn 解析器是符合EsTree规范的JavaScript的解析器，用来表述JavaScript的AST，
        // 之前的babel，webpack也在用
        // 目前比较热门的解析器有rust写的swc，go写的esbuild也能进行ast解析
        // https://astexplorer.net/
        parser = acorn.Parser.extend(
          ...(arraify(options.acornInjectPlugins) as any),
        )
      }
      return {
        acorn,
        acornInjectPlugins: [],
        ...options,
      }
    })(),

    getModuleInfo,
    // 开始构建
    // 在服务器启动时被调用
    async buildStart() {
      // 异步并发的执行所有钩子的buildStart钩子函数
      await hookParallel(
        'buildStart',
        (plugin) => new Context(plugin),
        () => [container.options as NormalizedInputOptions],
      )
    },
    // 这个钩子会在每个传入模块请求时被调用
    // 主要是获取模块的对于地址的唯一标识
    // 执行顺序是按照插件列表的顺序串行的执行每一个插件的 resolveId 方法， 如果有返回 id 则直接返回，否则继续执行，都执行完没有 id 则返回 null。
    // 在 Rollup 中，resolveId 钩子用于将导入的模块 ID 解析为绝对路径或外部 URL
    // 请注意，如果您返回 null，则 Rollup 将使用默认的解析逻辑来解析模块 ID
    async resolveId(rawId, importer = join(root, 'index.html'), options) {
      debugger
      const skip = options?.skip
      const ssr = options?.ssr
      const scan = !!options?.scan
      const ctx = new Context()
      ctx.ssr = !!ssr
      ctx._scan = scan
      ctx._resolveSkips = skip
      const resolveStart = isDebug ? performance.now() : 0

      let id: string | null = null
      const partial: Partial<PartialResolvedId> = {}
      for (const plugin of getSortedPlugins('resolveId')) {
        if (!plugin.resolveId) continue
        if (skip?.has(plugin)) continue

        ctx._activePlugin = plugin

        const pluginResolveStart = isDebug ? performance.now() : 0
        // 这里主要调用插件的resolveId方法，返回结果，这里也支持自定义handler来处理返回结果
        const handler =
          'handler' in plugin.resolveId
            ? plugin.resolveId.handler
            : plugin.resolveId
        // 这里其实就是找resolveId的过程，一旦有返回结果，说明已经找到了，后续的循环就不再执行了
        const result = await handler.call(ctx as any, rawId, importer, {
          assertions: options?.assertions ?? {},
          custom: options?.custom,
          isEntry: !!options?.isEntry,
          ssr,
          scan,
        })
        if (!result) continue

        if (typeof result === 'string') {
          id = result
        } else {
          id = result.id
          Object.assign(partial, result)
        }

        isDebug &&
          debugPluginResolve(
            timeFrom(pluginResolveStart),
            plugin.name,
            prettifyUrl(id, root),
          )

        // resolveId() is hookFirst - first non-null result is returned.
        // 得到一个resolveId结果后，那后面的插件的resolveId将不会被执行
        break
      }
      // const FS_PREFIX: "/@fs/"
      if (isDebug && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
        const key = rawId + id
        // avoid spamming
        if (!seenResolves[key]) {
          seenResolves[key] = true
          debugResolve(
            `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
              id,
            )}`,
          )
        }
      }

      if (id) {
        // 判断resolveId是否是第三方引入的id
        // normalizePath是处理文件路径的函数
        partial.id = isExternalUrl(id) ? id : normalizePath(id)
        return partial as PartialResolvedId
      } else {
        // id不存在就返回null
        return null
      }
    },
    // 该钩子在每个传入模块请求时被调用，主要是为了加载资源的
    // 在 Rollup 中，load 钩子用于加载模块。 如果您需要更改模块的加载方式，例如从不同的位置加载模块，则可以使用此钩子。
    // 按照插件顺序串行的执行每一个钩子的 load 方法，如果有返回则直接返回，否则都执行完没有返回，返回 null
    async load(id, options) {
      debugger
      const ssr = options?.ssr
      const ctx = new Context()
      ctx.ssr = !!ssr
      for (const plugin of getSortedPlugins('load')) {
        if (!plugin.load) continue
        ctx._activePlugin = plugin
        const handler =
          'handler' in plugin.load ? plugin.load.handler : plugin.load
        const result = await handler.call(ctx as any, id, { ssr })
        if (result != null) {
          if (isObject(result)) {
            updateModuleInfo(id, result)
          }
          return result
        }
      }
      return null
    },
    // 该钩子在每个传入模块请求时被调用，主要是为了对加载的源代码进行处理的
    // 接受文件源代码，然后按照插件顺序串行的依次执行 transform 方法
    // 前一个插件处理 code 结果作为后一个插件输入指导所有的插件都执行完毕为止，在此过程中还会使用 rollup 能力生成对应的 sourcemap
    async transform(code, id, options) {
      debugger
      const inMap = options?.inMap
      const ssr = options?.ssr
      const ctx = new TransformContext(id, code, inMap as SourceMap)
      ctx.ssr = !!ssr
      // 与resolveId不同，每一个插件的transform它都会执行
      for (const plugin of getSortedPlugins('transform')) {
        if (!plugin.transform) continue
        ctx._activePlugin = plugin
        ctx._activeId = id
        ctx._activeCode = code
        const start = isDebug ? performance.now() : 0
        let result: TransformResult | string | undefined
        const handler =
          'handler' in plugin.transform
            ? plugin.transform.handler
            : plugin.transform
        try {
          result = await handler.call(ctx as any, code, id, { ssr })
        } catch (e) {
          ctx.error(e)
        }
        if (!result) continue
        isDebug &&
          debugPluginTransform(
            timeFrom(start),
            plugin.name,
            prettifyUrl(id, root),
          )
        // 对transform的结果进行判断
        if (isObject(result)) {
          if (result.code !== undefined) {
            code = result.code
            // 支持sourcemap
            if (result.map) {
              if (isDebugSourcemapCombineFocused) {
                // @ts-expect-error inject plugin name for debug purpose
                // 注入插件名用于调式
                result.map.name = plugin.name
              }
              // sourcemap相关
              ctx.sourcemapChain.push(result.map)
            }
          }
          updateModuleInfo(id, result)
        } else {
          code = result
        }
      }
      return {
        code,
        map: ctx._getCombinedSourcemap(),
      }
    },

    async close() {
      if (closed) return
      const ctx = new Context()
      await hookParallel(
        'buildEnd',
        () => ctx,
        () => [],
      )
      await hookParallel(
        'closeBundle',
        () => ctx,
        () => [],
      )
      closed = true
    },
  }

  return container
}
