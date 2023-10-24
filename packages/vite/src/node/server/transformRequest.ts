import { promises as fs } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import getEtag from 'etag'
import convertSourceMap from 'convert-source-map'
import type { SourceDescription, SourceMap } from 'rollup'
import colors from 'picocolors'
import type { ViteDevServer } from '..'
import {
  blankReplacer,
  cleanUrl,
  createDebugger,
  ensureWatchedFile,
  isObject,
  prettifyUrl,
  removeTimestampQuery,
  timeFrom,
} from '../utils'
import { checkPublicFile } from '../plugins/asset'
import { getDepsOptimizer } from '../optimizer'
import { injectSourcesContent } from './sourcemap'
import { isFileServingAllowed } from './middlewares/static'

export const ERR_LOAD_URL = 'ERR_LOAD_URL'
export const ERR_LOAD_PUBLIC_URL = 'ERR_LOAD_PUBLIC_URL'

const debugLoad = createDebugger('vite:load')
const debugTransform = createDebugger('vite:transform')
const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

export interface TransformResult {
  code: string
  map: SourceMap | null
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}

export interface TransformOptions {
  ssr?: boolean
  html?: boolean
}

// 依次调用所有插件的 resolve、load 和 transform 钩子函数
// 获取文件源码
export function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {},
): Promise<TransformResult | null> {
  const cacheKey = (options.ssr ? 'ssr:' : options.html ? 'html:' : '') + url

  // This module may get invalidated while we are processing it. For example
  // when a full page reload is needed after the re-processing of pre-bundled
  // dependencies when a missing dep is discovered. We save the current time
  // to compare it to the last invalidation performed to know if we should
  // cache the result of the transformation or we should discard it as stale.
  //
  // A module can be invalidated due to:
  // 1. A full reload because of pre-bundling newly discovered deps
  // 2. A full reload after a config change
  // 3. The file that generated the module changed
  // 4. Invalidation for a virtual module
  //
  // For 1 and 2, a new request for this module will be issued after
  // the invalidation as part of the browser reloading the page. For 3 and 4
  // there may not be a new request right away because of HMR handling.
  // In all cases, the next time this module is requested, it should be
  // re-processed.
  //
  // We save the timestamp when we start processing and compare it with the
  // last time this module is invalidated
  const timestamp = Date.now()
  // 是否正在请求
  const pending = server._pendingRequests.get(cacheKey)
  if (pending) {
    // 根据url来获取module
    return server.moduleGraph
      .getModuleByUrl(removeTimestampQuery(url), options.ssr)
      .then((module) => {
        if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
          // The pending request is still valid, we can safely reuse its result
          return pending.request
        } else {
          // Request 1 for module A     (pending.timestamp)
          // Invalidate module A        (module.lastInvalidationTimestamp)
          // Request 2 for module A     (timestamp)

          // First request has been invalidated, abort it to clear the cache,
          // then perform a new doTransform.
          pending.abort()
          return transformRequest(url, server, options)
        }
      })
  }
  // doTransform 返回一个 Promise 对象
  // transform的核心逻辑
  const request = doTransform(url, server, options, timestamp)

  // Avoid clearing the cache of future requests if aborted
  // 当中止时避免清除未来请求的缓存
  let cleared = false
  const clearCache = () => {
    if (!cleared) {
      server._pendingRequests.delete(cacheKey)
      cleared = true
    }
  }

  // Cache the request and clear it once processing is done
  // 缓存请求结果
  server._pendingRequests.set(cacheKey, {
    request,
    timestamp,
    abort: clearCache,
  })
  // 设置回调
  request.then(clearCache, clearCache)

  return request
}

async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number,
) {
  // 获取一个去掉时间参数t=xxxx的url
  url = removeTimestampQuery(url)

  const { config, pluginContainer } = server
  const prettyUrl = isDebug ? prettifyUrl(url, config.root) : ''
  const ssr = !!options.ssr
  // 获取当前文件对应的 ModuleNode 对象
  const module = await server.moduleGraph.getModuleByUrl(url, ssr)

  // check if we have a fresh cache
  // 获取当前文件转换后的代码，如果有则返回
  // 如果没有找到，则说明在moduleGraph中没有维护关系（缓存）
  const cached =
    module && (ssr ? module.ssrTransformResult : module.transformResult)
  if (cached) {
    // TODO: check if the module is "partially invalidated" - i.e. an import
    // down the chain has been fully invalidated, but this current module's
    // content has not changed.
    // in this case, we can reuse its previous cached result and only update
    // its import timestamps.

    isDebug && debugCache(`[memory] ${prettyUrl}`)
    return cached
  }
  // 调用所有插件的 resolveId钩子函数，获取请求文件在项目中的绝对路径
  // /xxx/yyy/zzz/src/main.ts
  // resolve
  // rollup能力
  // 在Rollup中，resolveId钩子是一个可选的插件钩子，用于解析模块的标识符（例如导入的模块路径）并确定模块的位置。
  // 当Rollup遇到导入语句时，它会调用resolveId钩子来确定导入的模块的位置。
  // resolveId钩子的目标是返回解析后的模块的绝对路径
  // 这个方法在vite中有重新实现
  const id =
    (await pluginContainer.resolveId(url, undefined, { ssr }))?.id || url

  const result = loadAndTransform(id, url, server, options, timestamp)

  getDepsOptimizer(config, ssr)?.delayDepsOptimizerUntil(id, () => result)

  return result
}

async function loadAndTransform(
  id: string,
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number,
) {
  const { config, pluginContainer, moduleGraph, watcher } = server
  const { root, logger } = config
  const prettyUrl = isDebug ? prettifyUrl(url, config.root) : ''
  const ssr = !!options.ssr
   // 去掉 id 中的 query 和 hash
  const file = cleanUrl(id)

  let code: string | null = null
  let map: SourceDescription['map'] = null

  // load
  const loadStart = isDebug ? performance.now() : 0
  // 调用所有插件的 load 钩子函数，如果所有插件的 load 钩子函数都没有处理过该文件，则返回 null
  // 在Rollup中，load钩子是一个可选的插件钩子，用于加载模块的内容。当Rollup需要获取模块的实际内容时，它会调用load钩子
  // 这个方法在vite中有重新实现
  const loadResult = await pluginContainer.load(id, { ssr })
  // 大部分的js请求，loadResult是存在的
  if (loadResult == null) {
    // if this is an html request and there is no load result, skip ahead to
    // SPA fallback.
    // 判断一下是否是html的请求，并且是否没有结果返回（通过判断.html），跳过至spa方案
    // id是文件的绝对路径
    // 什么情况下会命中这个逻辑啊
    if (options.html && !id.endsWith('.html')) {
      debugger
      return null
    }
    // try fallback loading it from fs as string
    // if the file is a binary, there should be a plugin that already loaded it
    // as string
    // only try the fallback if access is allowed, skip for out of root url
    // like /service-worker.js or /api/users
    if (options.ssr || isFileServingAllowed(file, server)) {
      try {
        // 读取文件中的代码
        code = await fs.readFile(file, 'utf-8')
        isDebug && debugLoad(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw e
        }
      }
    }
    if (code) {
      // 如果读到了代码，先将代码转成SourceMap
      try {
        map = (
          convertSourceMap.fromSource(code) ||
          (await convertSourceMap.fromMapFileSource(
            code,
            createConvertSourceMapReadMap(file),
          ))
        )?.toObject()

        code = code.replace(convertSourceMap.mapFileCommentRegex, blankReplacer)
      } catch (e) {
        logger.warn(`Failed to load source map for ${url}.`, {
          timestamp: true,
        })
      }
    }
  } else {
    isDebug && debugLoad(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    // 获取 code 和 map
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
    } else {
      code = loadResult
    }
  }
  if (code == null) {
    const isPublicFile = checkPublicFile(url, config)
    const msg = isPublicFile
      ? `This file is in /public and will be copied as-is during build without ` +
        `going through the plugin transforms, and therefore should not be ` +
        `imported from source code. It can only be referenced via HTML tags.`
      : `Does the file exist?`
    const err: any = new Error(
      `Failed to load url ${url} (resolved id: ${id}). ${msg}`,
    )
    err.code = isPublicFile ? ERR_LOAD_PUBLIC_URL : ERR_LOAD_URL
    throw err
  }
  // ensure module in graph after successful load
  // 创建/获取当前文件的 ModuleNode 对象
  // 对新的模块建立关系
  const mod = await moduleGraph.ensureEntryFromUrl(url, ssr)
  // 作为第一次出现的文件，当然要对它进行监听
  // 如果已经监听了，则不需要再次监听
  ensureWatchedFile(watcher, mod.file, root)

  // transform
  // 调用所有插件的transform钩子函数转换源码
  // 其中也包含importAnalysis插件中定义的transform方法
  // 在Rollup中，transform钩子是一个可选的插件钩子，用于在模块转换过程中对模块的代码进行修改或转换。
  // 当Rollup对模块进行转换时，它会调用transform钩子
  // 通常情况下，transform钩子被用于执行一些特定的编译任务，例如使用Babel进行ES6到ES5的转换、应用CSS预处理器、将TypeScript代码转换为JavaScript等。
  // transform钩子接收一个模块的源代码作为输入，并返回转换后的代码。你可以在钩子函数中执行任何所需的转换操作，并返回修改后的代码供Rollup继续处理
  const transformStart = isDebug ? performance.now() : 0
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
    ssr,
  })
  const originalCode = code
  if (
    transformResult == null ||
    (isObject(transformResult) && transformResult.code == null)
  ) {
    // no transform applied, keep code as-is
    isDebug &&
      debugTransform(
        timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`),
      )
  } else {
    isDebug && debugTransform(`${timeFrom(transformStart)} ${prettyUrl}`)
    code = transformResult.code!
    map = transformResult.map
  }
  // 将sourcemap注入到code里面
  // 这样sourcemap不必进行单独请求
  if (map && mod.file) {
    map = (typeof map === 'string' ? JSON.parse(map) : map) as SourceMap
    if (map.mappings && !map.sourcesContent) {
      await injectSourcesContent(map, mod.file, logger)
    }
  }
  // 返回转换后的代码、map信息和 etag值
  const result = ssr
    ? await server.ssrTransform(code, map as SourceMap, url, originalCode)
    : ({
        code,
        map,
        // 生成etag
        etag: getEtag(code, { weak: true }),
      } as TransformResult)

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp) {
    if (ssr) mod.ssrTransformResult = result
    else mod.transformResult = result
  }

  return result
}

function createConvertSourceMapReadMap(originalFileName: string) {
  return (filename: string) => {
    return fs.readFile(
      path.resolve(path.dirname(originalFileName), filename),
      'utf-8',
    )
  }
}
