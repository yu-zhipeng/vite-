import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Connect } from 'dep-types/connect'
import colors from 'picocolors'
import type { ViteDevServer } from '..'
import {
  cleanUrl,
  createDebugger,
  ensureVolumeInPath,
  fsPathFromId,
  injectQuery,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  unwrapId,
} from '../../utils'
import { send } from '../send'
import { ERR_LOAD_URL, transformRequest } from '../transformRequest'
import { isHTMLProxy } from '../../plugins/html'
import {
  DEP_VERSION_RE,
  FS_PREFIX,
  NULL_BYTE_PLACEHOLDER,
} from '../../constants'
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest,
} from '../../plugins/css'
import {
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
  ERR_OUTDATED_OPTIMIZED_DEP,
} from '../../plugins/optimizedDeps'
import { getDepsOptimizer } from '../../optimizer'

const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

// 会忽略favicon.ico哎
const knownIgnoreList = new Set(['/', '/favicon.ico'])

export function transformMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  const {
    config: { root, logger },
    moduleGraph,
  } = server

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteTransformMiddleware(req, res, next) {
    debugger
    // 只处理 GET 请求，且不在忽略列表里面的，其他不处理
    if (req.method !== 'GET' || knownIgnoreList.has(req.url!)) {
      return next()
    }

    let url: string
    try {
      // 将 url 的 t=xxx 去掉，并将 url 中的 __x00__ 替换成 \0，这个`\0`是rollup的约定，标识虚拟模块的
      // 防止其他插件对其进行处理，比如节点解析，同时也帮助 sourcemap 区分虚拟模块与真实模块
      // 例如 url = /src/main.ts
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        '\0',
      )
    } catch (e) {
      return next(e)
    }
    // 去掉 hash 和 query
    // withoutQuery = /src/main.ts
    const withoutQuery = cleanUrl(url)

    try {
      // .map 文件相关
      const isSourceMap = withoutQuery.endsWith('.map')
      // since we generate source map references, handle those requests here
      if (isSourceMap) {
        const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
        if (depsOptimizer?.isOptimizedDepUrl(url)) {
          // If the browser is requesting a source map for an optimized dep, it
          // means that the dependency has already been pre-bundled and loaded
          const mapFile = url.startsWith(FS_PREFIX)
            ? fsPathFromId(url)
            : normalizePath(
                ensureVolumeInPath(path.resolve(root, url.slice(1))),
              )
          try {
            const map = await fs.readFile(mapFile, 'utf-8')
            // 
            return send(req, res, map, 'json', {
              headers: server.config.server.headers,
            })
          } catch (e) {
            // Outdated source map request for optimized deps, this isn't an error
            // but part of the normal flow when re-optimizing after missing deps
            // Send back an empty source map so the browser doesn't issue warnings
            // 这里为啥要返回一个空的map文件呢？
            // 为过期的请求返回空源映射，为了防止浏览器警告
            const dummySourceMap = {
              version: 3,
              file: mapFile.replace(/\.map$/, ''),
              sources: [],
              sourcesContent: [],
              names: [],
              mappings: ';;;;;;;;;',
            }
            return send(req, res, JSON.stringify(dummySourceMap), 'json', {
              cacheControl: 'no-cache',
              headers: server.config.server.headers,
            })
          }
        } else {
          const originalUrl = url.replace(/\.map($|\?)/, '$1')
          const map = (await moduleGraph.getModuleByUrl(originalUrl, false))
            ?.transformResult?.map
          if (map) {
            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers,
            })
          } else {
            // 找不到map文件，就next
            return next()
          }
        }
      }

      // check if public dir is inside root dir
      // 检查公共目录是否在根目录内
      const publicDir = normalizePath(server.config.publicDir)
      const rootDir = normalizePath(server.config.root)
      if (publicDir.startsWith(rootDir)) {
        const publicPath = `${publicDir.slice(rootDir.length)}/`
        // warn explicit public paths
        if (url.startsWith(publicPath)) {
          let warning: string

          if (isImportRequest(url)) {
            const rawUrl = removeImportQuery(url)

            warning =
              'Assets in public cannot be imported from JavaScript.\n' +
              `Instead of ${colors.cyan(
                rawUrl,
              )}, put the file in the src directory, and use ${colors.cyan(
                rawUrl.replace(publicPath, '/src/'),
              )} instead.`
          } else {
            warning =
              `files in the public directory are served at the root path.\n` +
              `Instead of ${colors.cyan(url)}, use ${colors.cyan(
                url.replace(publicPath, '/'),
              )}.`
          }

          logger.warn(colors.yellow(warning))
        }
      }
      // 这里是真正的处理页面js请求的地方
      if (
        isJSRequest(url) || // 加载的是 js 文件，包括没有后缀的文件、jsx、tsx、mjs、js、ts、vue、astro等
        isImportRequest(url) || // url上挂有import参数的，Vite会对图片、JSON、客户端热更新时请求的文件等挂上import参数
        // http://192.168.56.1:3100/src/views/sys/login/Login.vue?import&t=1679966826130
        isCSSRequest(url) || // css文件，包括css、less、sass、scss、styl、stylus、pcss、postcss
        isHTMLProxy(url) // url 匹配 /\?html-proxy&index=(\d+)\.js$/的
      ) {
        // strip ?import
        // 删除 [?|&]import
        url = removeImportQuery(url)
        // Strip valid id prefix. This is prepended to resolved Ids that are
        // not valid browser import specifiers by the importAnalysis plugin.
        // 如果 url 以 /@id/ 开头，则去掉 /@id/
        url = unwrapId(url)

        // for CSS, we need to differentiate between normal CSS requests and
        // imports
        // 如果是css请求，并且url上没有带direct参数
        if (
          isCSSRequest(url) &&
          !isDirectRequest(url) &&
          req.headers.accept?.includes('text/css')
        ) {
          // 这里加上direct参数
          url = injectQuery(url, 'direct')
        }

        // check if we can return 304 early
        // 通过If-None-Match这个条件请求来验证资源是否修改
        // 如果存在，它将返回etag
        // If-None-Match: 3eb341a8cf01583777565e13f532101a
        // 只需要比较etag，如果一样，就返回304，让浏览器从缓存里面读取
        // 如果不相同，就将If-None-Match的值设为true，返回状态码为200，客户端重新解析服务器返回的数据
        const ifNoneMatch = req.headers['if-none-match']
        // 这里通过moduleGraph模块图谱来找到对应文件的etag
        if (
          ifNoneMatch &&
          (await moduleGraph.getModuleByUrl(url, false))?.transformResult
            ?.etag === ifNoneMatch
        ) {
          isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
          res.statusCode = 304
          return res.end()
        }

        // resolve, load and transform using the plugin container
        // 依次调用所有插件的 resolve、load 和 transform 钩子函数
        // 如果不能使用缓存，则通过transformRequest方法获取文件源码
        const result = await transformRequest(url, server, {
          // 判读请求是否请求的html文件
          html: req.headers.accept?.includes('text/html'),
        })
        if (result) {
          const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
          const type = isDirectCSSRequest(url) ? 'css' : 'js'
          // true：url 上有 v=xxx 参数的，或者是以 cacheDirPrefix 开头的url
          // 对于 url 上有v=xxx参数的，或者是以缓存目录(比如_vite)开头的 url，设置强制缓存
          const isDep =
            DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url)
          //将解析之后的代码组装发送给客户端
          return send(req, res, result.code, type, {
            etag: result.etag,
            // allow browser to cache npm deps!
            // 对预构建模块添加强缓存
            cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache',
            headers: server.config.server.headers,
            map: result.map,
          })
        }
      }
    } catch (e) {
      if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.end()
        }
        // This timeout is unexpected
        logger.error(e.message)
        return
      }
      if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      if (e?.code === ERR_LOAD_URL) {
        // Let other middleware handle if we can't load the url via transformRequest
        return next()
      }
      return next(e)
    }

    next()
  }
}
