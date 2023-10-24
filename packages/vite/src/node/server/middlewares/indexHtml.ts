import fs from 'node:fs'
import path from 'node:path'
import MagicString from 'magic-string'
import type { SourceMapInput } from 'rollup'
import type { Connect } from 'dep-types/connect'
import type { DefaultTreeAdapterMap, Token } from 'parse5'
import type { IndexHtmlTransformHook } from '../../plugins/html'
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  assetAttrsConfig,
  getAttrKey,
  getScriptInfo,
  nodeIsElement,
  overwriteAttrValue,
  postImportMapHook,
  preImportMapHook,
  resolveHtmlTransforms,
  traverseHtml,
} from '../../plugins/html'
import type { ResolvedConfig, ViteDevServer } from '../..'
import { send } from '../send'
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from '../../constants'
import {
  cleanUrl,
  ensureWatchedFile,
  fsPathFromId,
  injectQuery,
  joinUrlSegments,
  normalizePath,
  processSrcSetSync,
  wrapId,
} from '../../utils'
import type { ModuleGraph } from '../moduleGraph'

interface AssetNode {
  start: number
  end: number
  code: string
}

// transformIndexHtml本尊
// 遍历所有插件，获取插件中定义的transformIndexHtml，并根据规则划分为postHooks和preHooks，并返回一个匿名函数
export function createDevHtmlTransformFn(
  server: ViteDevServer,
): (url: string, html: string, originalUrl: string) => Promise<string> {
  // 遍历所有 plugin，获取 plugin.transformIndexHtml
  // 如果 plugin.transformIndexHtml 是一个函数，添加到 postHooks中
  // 如果 plugin.transformIndexHtml 是一个对象并且 transformIndexHtml.enforce === 'pre'，添加到 preHooks 中
  // 如果 plugin.transformIndexHtml 是一个对象并且 transformIndexHtml.enforce !== 'pre'，添加到 postHooks 中
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    server.config.plugins,
  )
  // 这个匿名函数就是server.transformIndexHtml的值
  return (url: string, html: string, originalUrl: string): Promise<string> => {
    // 应用html转换
    return applyHtmlTransforms(
      html,
      [
        preImportMapHook(server.config),
        ...preHooks,
        // Vite 内部的函数
        devHtmlHook,
        ...normalHooks,
        ...postHooks,
        postImportMapHook(),
      ],
      {
        path: url,
        filename: getHtmlFilename(url, server),
        server,
        originalUrl,
      },
    )
  }
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url))
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1))),
    )
  }
}

const startsWithSingleSlashRE = /^\/(?!\/)/
const processNodeUrl = (
  attr: Token.Attribute,
  sourceCodeLocation: Token.Location,
  s: MagicString,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  moduleGraph?: ModuleGraph,
) => {
  let url = attr.value || ''

  if (moduleGraph) {
    const mod = moduleGraph.urlToModuleMap.get(url)
    if (mod && mod.lastHMRTimestamp > 0) {
      url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
    }
  }
  const devBase = config.base
  if (startsWithSingleSlashRE.test(url)) {
    // prefix with base (dev only, base is never relative)
    const fullUrl = path.posix.join(devBase, url)
    overwriteAttrValue(s, sourceCodeLocation, fullUrl)
  } else if (
    url.startsWith('.') &&
    originalUrl &&
    originalUrl !== '/' &&
    htmlPath === '/index.html'
  ) {
    // prefix with base (dev only, base is never relative)
    const replacer = (url: string) => path.posix.join(devBase, url)

    // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
    // path will add `/a/` prefix, it will caused 404.
    // rewrite before `./index.js` -> `localhost:5173/a/index.js`.
    // rewrite after `../index.js` -> `localhost:5173/index.js`.

    const processedUrl =
      attr.name === 'srcset' && attr.prefix === undefined
        ? processSrcSetSync(url, ({ url }) => replacer(url))
        : replacer(url)
    overwriteAttrValue(s, sourceCodeLocation, processedUrl)
  }
}
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl },
) => {
  debugger
  const { config, moduleGraph, watcher } = server!
  const base = config.base || '/'

  let proxyModulePath: string
  let proxyModuleUrl: string

  const trailingSlash = htmlPath.endsWith('/')
  if (!trailingSlash && fs.existsSync(filename)) {
    proxyModulePath = htmlPath
    proxyModuleUrl = joinUrlSegments(base, htmlPath)
  } else {
    // There are users of vite.transformIndexHtml calling it with url '/'
    // for SSR integrations #7993, filename is root for this case
    // A user may also use a valid name for a virtual html file
    // Mark the path as virtual in both cases so sourcemaps aren't processed
    // and ids are properly handled
    const validPath = `${htmlPath}${trailingSlash ? 'index.html' : ''}`
    proxyModulePath = `\0${validPath}`
    proxyModuleUrl = wrapId(proxyModulePath)
  }

  const s = new MagicString(html)
  let inlineModuleIndex = -1
  const proxyCacheUrl = cleanUrl(proxyModulePath).replace(
    normalizePath(config.root),
    '',
  )
  const styleUrl: AssetNode[] = []

  const addInlineModule = (
    node: DefaultTreeAdapterMap['element'],
    ext: 'js',
  ) => {
    inlineModuleIndex++

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap['textNode']

    const code = contentNode.value

    let map: SourceMapInput | undefined
    if (!proxyModulePath.startsWith('\0')) {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset,
        )
        .generateMap({ hires: true })
      map.sources = [filename]
      map.file = filename
    }

    // add HTML Proxy to Map
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, { code, map })

    // inline js module. convert to src="proxy" (dev only, base is never relative)
    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`

    // invalidate the module so the newly cached contents will be served
    const module = server?.moduleGraph.getModuleById(modulePath)
    if (module) {
      server?.moduleGraph.invalidateModule(module)
    }
    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`,
    )
  }

  // 将传入的html交给traverseHtml处理
  await traverseHtml(html, filename, (node) => {
    debugger
    // 回调函数 visitor
    // 访问器只处理如下标签，这些标签都可以引入文件
    // script  link  video  source  img  image  use
    // 如果node不是el标准的节点类型 直接返回
    if (!nodeIsElement(node)) {
      return
    }

    // script tags
    // 处理 script 标签
    // 主要是处理行内js和引入js文件的script标签
    if (node.nodeName === 'script') {
      // 获取 src 属性
      // isModule：是一个行内 js，并且有 type='module' 属性，则为 true
      const { src, sourceCodeLocation, isModule } = getScriptInfo(node)

      if (src) {
        processNodeUrl(
          src,
          sourceCodeLocation!,
          s,
          config,
          htmlPath,
          originalUrl,
          moduleGraph,
        )
      } else if (isModule && node.childNodes.length) {
        // 处理 type==='module' 的行内js
        addInlineModule(node, 'js')
      }
    }
    // 处理style标签
    if (node.nodeName === 'style' && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap['textNode']
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      })
    }

    // elements with [href/src] attrs
    const assetAttrs = assetAttrsConfig[node.nodeName]
    if (assetAttrs) {
      for (const p of node.attrs) {
        const attrKey = getAttrKey(p)
        if (p.value && assetAttrs.includes(attrKey)) {
          processNodeUrl(
            p,
            node.sourceCodeLocation!.attrs![attrKey],
            s,
            config,
            htmlPath,
            originalUrl,
          )
        }
      }
    }
  })

  await Promise.all(
    styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`

      // ensure module in graph after successful load
      const mod = await moduleGraph.ensureEntryFromUrl(url, false)
      ensureWatchedFile(watcher, mod.file, config.root)

      const result = await server!.pluginContainer.transform(code, mod.id!)
      s.overwrite(start, end, result?.code || '')
    }),
  )
  // 获取最新的 html 字符串
  html = s.toString()
  // 最后返回 html 和 tags
  // 最后返回html和tags，这个tags会将下面的代码插入到head标签头部
  // <script type="module" src="/@vite/client"></script>
  return {
    html,
    tags: [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export function indexHtmlMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    // 只在可写入的时候进行处理
    if (res.writableEnded) {
      return next()
    }

    const url = req.url && cleanUrl(req.url)
    // htmlFallbackMiddleware appends '.html' to URLs
    // 这里只处理html文件
    // Sec-Fetch-Dest Fetch 元数据请求标头指示请求的目标，即数据的来源以及如何使用这些获取到的数据
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') {
      const filename = getHtmlFilename(url, server)
      if (fs.existsSync(filename)) {
        try {
          let html = fs.readFileSync(filename, 'utf-8')
          // 调用server.transformIndexHtml函数转换 HTML，最后返回给客户端
          html = await server.transformIndexHtml(url, html, req.originalUrl)
          return send(req, res, html, 'html', {
            headers: server.config.server.headers,
          })
        } catch (e) {
          return next(e)
        }
      }
    }
    next()
  }
}
