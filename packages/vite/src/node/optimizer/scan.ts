import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import glob from 'fast-glob'
import type { Loader, OnLoadResult, Plugin } from 'esbuild'
import { build, transform } from 'esbuild'
import colors from 'picocolors'
import type { ResolvedConfig } from '..'
import {
  CSS_LANGS_RE,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from '../constants'
import {
  cleanUrl,
  createDebugger,
  dataUrlRE,
  externalRE,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { transformGlobImport } from '../plugins/importMetaGlob'

type ResolveIdOptions = Parameters<PluginContainer['resolveId']>[2]

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

export async function scanImports(config: ResolvedConfig): Promise<{
  deps: Record<string, string>
  missing: Record<string, string>
}> {
  // Only used to scan non-ssr code

  const start = performance.now()

  let entries: string[] = []

  const explicitEntryPatterns = config.optimizeDeps.entries
  const buildInput = config.build.rollupOptions?.input

  if (explicitEntryPatterns) {
    // 如果配置了依赖编译的入口
    entries = await globEntries(explicitEntryPatterns, config)
  } else if (buildInput) {
    // 获取rollup里面配置了build入口
    const resolvePath = (p: string) => path.resolve(config.root, p)
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  } else {
    // 默认将项目中所有的 html 文件作为入口，会排除 node_modules
    // 就这一会，服务也并行启动完成了
    debugger
    entries = await globEntries('**/*.html', config)
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  // 不支持的入口类型和虚拟文件不应该被扫描
  entries = entries.filter(
    (entry) => isScannable(entry) && fs.existsSync(entry),
  )

  if (!entries.length) {
    if (!explicitEntryPatterns && !config.optimizeDeps.include) {
      config.logger.warn(
        colors.yellow(
          '(!) Could not auto-determine entry point from rollupOptions or html files ' +
            'and there are no explicit optimizeDeps.include patterns. ' +
            'Skipping dependency pre-bundling.',
        ),
      )
    }
    return { deps: {}, missing: {} }
  } else {
    debug(`Crawling dependencies using entries:\n  ${entries.join('\n  ')}`)
  }
  // 扫描到的依赖，会放到该对象
  const deps: Record<string, string> = {}
  // 缺少的依赖，用于错误提示
  const missing: Record<string, string> = {}
  // container（插件容器）用于兼容 Rollup 插件生态，用于保证 dev 和 production 模式下，Vite 能有一致的表现
  const container = await createPluginContainer(config)
  debugger
  // esbuild 扫描插件
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries)
  // 获取用户配置的 esbuild 自定义配置，没有配置就是空的
  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {}
  // 进行构建
  await build({
    absWorkingDir: process.cwd(),
    write: false,
    stdin: {
      contents: entries.map((e) => `import ${JSON.stringify(e)}`).join('\n'),
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    logLevel: 'error',
    plugins: [...plugins, plugin],
    ...esbuildOptions,
  })

  debug(`Scan completed in ${(performance.now() - start).toFixed(2)}ms:`, deps)

  return {
    // Ensure a fixed order so hashes are stable and improve logs
    deps: orderedDependencies(deps),
    missing,
  }
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true, // suppress EACCES errors
  })
}

const scriptModuleRE =
  /(<script\b[^>]+type\s*=\s*(?:"module"|'module')[^>]*>)(.*?)<\/script>/gis
export const scriptRE = /(<script(?:\s[^>]*>|>))(.*?)<\/script>/gis
export const commentRE = /<!--.*?-->/gs
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i

function esbuildScanPlugin(
  config: ResolvedConfig, // Vite 的解析好的用户配置
  container: PluginContainer, // 这里只会用到 container.resolveId 的方法，这个方法能将模块路径转成真实路径。例如 vue 转成 xxx/node_modules/dist/vue.esm-bundler.js。
  depImports: Record<string, string>,// 用于存储扫描到的依赖对象，插件执行过程中会被修改
  missing: Record<string, string>,// 用于存储缺少的依赖的对象，插件执行过程中会被修改
  entries: string[],// 存储所有入口文件的数组
): Plugin {
  // 缓存已经收集过的依赖信息
  const seen = new Map<string, string | undefined>()
  debugger
  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions,
  ) => {
    debugger
    const key = id + (importer && path.dirname(importer))
    // 如果有缓存，就直接使用缓存
    if (seen.has(key)) {
      return seen.get(key)
    }
    // 将模块路径转成真实路径
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      },
    )
    // 缓存解析过的路径，之后可以直接获取
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  // 配置的要额外解析的路径
  const include = config.optimizeDeps?.include
  // 配置的要排除解析的模块
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env',
  ]

  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: !entries.includes(path),
  })

  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader,
  ) => {
    let transpiledContents
    // transpile because `transformGlobImport` only expects js
    if (loader !== 'js') {
      transpiledContents = (await transform(contents, { loader })).code
    } else {
      transpiledContents = contents
    }

    const result = await transformGlobImport(
      transpiledContents,
      id,
      config.root,
      resolve,
      config.isProduction,
    )

    return result?.s.toString() || transpiledContents
  }

  return {
    name: 'vite:dep-scan',
    setup(build) {
      debugger
      const scripts: Record<string, OnLoadResult> = {}
      // 省略一些 JS 无关的模块，配置external为true
      // external urls
      // externalRE = /^(https?:)?\/\//
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // data urls
      // dataUrlRE = /^\s*data:/i
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      // virtualModuleRE = /^virtual-module:.*/
      // 处理虚拟模块
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          // 去掉 prefix
          // // virtual-module:D:/project/index.html?id=0 => D:/project/index.html?id=0
          path: path.replace(virtualModulePrefix, ''),
          namespace: 'script',
        }
      })

      build.onLoad({ filter: /.*/, namespace: 'script' }, ({ path }) => {
        return scripts[path]
      })

      // html types: extract script contents -----------------------------------
      // htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/
      // 对于html等类似的文件
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        // 将模块路径，转成文件的真实路径
        const resolved = await resolve(path, importer)
        if (!resolved) return
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        // 扫描器可以扫描node_modules中的html类型。
        // 如果我们可以优化这个html类型，跳过它，这样它就会被直接导入解析处理，并记录为优化dep。
        // 不处理 node_modules 内的
        if (
          resolved.includes('node_modules') &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return
        return {
          path: resolved,
          namespace: 'html',
        }
      })

      // extract scripts inside HTML-like files and treat it as a js module
      // html等类似的文件加载时
      // 注意：这里的html文件已经加载阶段处理过了，将script标签的代码进行了转换
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'html' },
        async ({ path }) => {
          // 读取文件源码
          let raw = fs.readFileSync(path, 'utf-8')
          // Avoid matching the content of the comment
          // 去掉注释，避免后面匹配到注释
          raw = raw.replace(commentRE, '<!---->')
          // html 模块，需要匹配 module 类型的 script，因为只有 module 类型的 script 才能使用 import
          const isHtml = path.endsWith('.html')
          const regex = isHtml ? scriptModuleRE : scriptRE
          // 重置正则表达式的索引位置，因为同一个正则表达式对象，每次匹配后，lastIndex 都会改变
		      // regex 会被重复使用，每次都需要重置为 0，代表从第 0 个字符开始正则匹配
          regex.lastIndex = 0
          // load 钩子返回值，表示加载后的 js 代码
          let js = ''
          let scriptId = 0
          let match: RegExpExecArray | null
          // 匹配源码的 script 标签，用 while 循环，因为 html 可能有多个 script 标签
          while ((match = regex.exec(raw))) {
            // openTag: 它的值的例子： <script type="module" lang="ecmascript" src="xxx">
		        // content: script 标签的内容
            const [, openTag, content] = match
            // 正则匹配出 openTag 中的 type 和 lang 属性
            const typeMatch = openTag.match(typeRE)
            const type =
              typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
            const langMatch = openTag.match(langRE)
            const lang =
              langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
            // skip type="application/ld+json" and other non-JS types
            // 跳过 type="application/ld+json" 和其他非 non-JS 类型
            if (
              type &&
              !(
                type.includes('javascript') ||
                type.includes('ecmascript') ||
                type === 'module'
              )
            ) {
              continue
            }
            let loader: Loader = 'js'
            // esbuild load 钩子可以设置 应的 loader
            if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
              loader = lang
              // astro Snowpack团队的新玩具 islands架构的ssr构建工具
            } else if (path.endsWith('.astro')) {
              loader = 'ts'
            }
            // 正则匹配出 script src 属性
            const srcMatch = openTag.match(srcRE)
            // 有 src 属性，证明是外部 script
            if (srcMatch) {
              // src 可以有以下三种写法： src="xxx"  src='xxx'  src=xxx
              const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
              // 外部 script，改为用 import 用引入外部 script
              js += `import ${JSON.stringify(src)}\n`
            } else if (content.trim()) {
              // The reason why virtual modules are needed:
              // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
              // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
              // 2. There can be multiple module scripts in html
              // We need to handle these separately in case variable names are reused between them

              // append imports in TS to prevent esbuild from removing them
              // since they may be used in the template
              // 内联的 script，它的内容要做成虚拟模块
              // 缓存虚拟模块的内容
              // 一个 html 可能有多个 script，用 scriptId 区分
              const contents =
                content +
                (loader.startsWith('ts') ? extractImportPaths(content) : '')

              const key = `${path}?id=${scriptId++}`
              // 这里也要匹配是否存在import.meta.glob，避免后续的依赖二次收集
              if (contents.includes('import.meta.glob')) {
                scripts[key] = {
                  loader: 'js', // since it is transpiled
                  contents: await doTransformGlobImport(contents, path, loader),
                  pluginData: {
                    htmlType: { loader },
                  },
                }
              } else {
                scripts[key] = {
                  loader,
                  contents,
                  pluginData: {
                    htmlType: { loader },
                  },
                }
              }
              // 虚拟模块的路径，如 virtual-module:D:/project/index.html?id=0
              const virtualModulePath = JSON.stringify(
                virtualModulePrefix + key,
              )

              const contextMatch = openTag.match(contextRE)
              const context =
                contextMatch &&
                (contextMatch[1] || contextMatch[2] || contextMatch[3])

              // Especially for Svelte files, exports in <script context="module"> means module exports,
              // exports in <script> means component props. To avoid having two same export name from the
              // star exports, we need to ignore exports in <script>
              if (path.endsWith('.svelte') && context !== 'module') {
                js += `import ${virtualModulePath}\n`
              } else {
                js += `export * from ${virtualModulePath}\n`
              }
            }
          }

          // This will trigger incorrectly if `export default` is contained
          // anywhere in a string. Svelte and Astro files can't have
          // `export default` as code so we know if it's encountered it's a
          // false positive (e.g. contained in a string)
          if (!path.endsWith('.vue') || !js.includes('export default')) {
            js += '\nexport default {}'
          }

          return {
            loader: 'js',
            contents: js,
          }
        },
      )

      // bare imports: record and externalize ----------------------------------
      // 匹配裸模块
      build.onResolve(
        {
          // avoid matching windows volume
          // 第一个字符串为字母或 @，且第二个字符串不是 : 冒号。如 vite、@vite/plugin-vue
          // 目的是：避免匹配 window 路径，如 D:/xxx
          filter: /^[\w@][^:]/,
        },
        async ({ path: id, importer, pluginData }) => {
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          // 将模块路径转换成真实路径，实际上调用 container.resolveId
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          // 如果解析到路径，证明找得到依赖
          // 如果解析不到路径，则证明找不到依赖，要记录下来后面报错
          if (resolved) {
            // 虚拟路径、非绝对路径、非 .jsx .tsx .mjs .html .vue .svelte .astro 文件返回 true
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            // 如果模块在 node_modules 中，或者在optimizeDeps.include 配置中，则记录 bare import
            if (resolved.includes('node_modules') || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (isOptimizable(resolved, config.optimizeDeps)) {
                // 记录 bare import
                depImports[id] = resolved
              }
              // 如果当前id没有包含在entries时，external: true，直接忽略
              return externalUnlessEntry({ path: id })
              // isScannable 判断该文件是否可以扫描，可扫描的文件有 JS、html、vue 等
              // 因为有可能裸依赖的入口是 css 等非 JS 模块的文件
            } else if (isScannable(resolved)) {
              // 真实路径不在 node_modules 中，则证明是 monorepo，实际上代码还是在用户的目录中
              // 是用户自己写的代码，不应该 external
              const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace,
              }
            } else {
              // 其他模块不可扫描，直接忽略，external
              return externalUnlessEntry({ path: id })
            }
          } else {
            // 解析不到依赖，则记录缺少的依赖
            missing[id] = normalizePath(importer)
          }
        },
      )

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css
      build.onResolve({ filter: CSS_LANGS_RE }, externalUnlessEntry)

      // json & wasm
      build.onResolve({ filter: /\.(json|json5|wasm)$/ }, externalUnlessEntry)

      // known asset types
      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`),
        },
        externalUnlessEntry,
      )

      // known vite query types: ?worker, ?raw
      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({
        path,
        external: true,
      }))

      // catch all -------------------------------------------------------------

      build.onResolve(
        {
          filter: /.*/,
        },
        async ({ path: id, importer, pluginData }) => {
          // use vite resolver to support urls and omitted extensions
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            if (shouldExternalizeDep(resolved, id) || !isScannable(resolved)) {
              return externalUnlessEntry({ path: id })
            }

            const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined

            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace,
            }
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id })
          }
        },
      )

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      build.onLoad({ filter: JS_TYPES_RE }, async ({ path: id }) => {
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = fs.readFileSync(id, 'utf-8')
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader)

        if (contents.includes('import.meta.glob')) {
          return {
            loader: 'js', // since it is transpiled,
            contents: await doTransformGlobImport(contents, id, loader),
          }
        }

        return {
          loader,
          contents,
        }
      })
    },
  }
}

/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  importsRE.lastIndex = 0
  while ((m = importsRE.exec(code)) != null) {
    js += `\nimport ${m[1]}`
  }
  return js
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

function isScannable(id: string): boolean {
  return JS_TYPES_RE.test(id) || htmlTypesRE.test(id)
}
