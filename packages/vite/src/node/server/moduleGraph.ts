import { extname } from 'node:path'
import type { ModuleInfo, PartialResolvedId } from 'rollup'
import { isDirectCSSRequest } from '../plugins/css'
import {
  cleanUrl,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery,
} from '../utils'
import { FS_PREFIX } from '../constants'
import type { TransformResult } from './transformRequest'

// 每种构建工具都会有一个 Graph 用于维护模块之间的引用和模块信息
export class ModuleNode {
  /**
   * Public served url path, starts with /
   */
  //  以 / 开头的 url，比如 /src/assets/logo.png
  url: string
  /**
   * Resolved file system path + query
   */
  // 模块绝对路径，可能带有 query 和 hash
  id: string | null = null
  // 不带 query 和 hash 的模块绝对路径
  file: string | null = null
  // 如果是 css 文件并且路径上带有 direct 参数则为'css'，否则为 'js'
  type: 'js' | 'css'
  // 
  info?: ModuleInfo
  meta?: Record<string, any>
  // 导入该模块的模块合集 Set，元素是 ModuleNode 对象
  importers = new Set<ModuleNode>()
  // 当前模块的导入模块合集 Set，元素是 ModuleNode 对象
  importedModules = new Set<ModuleNode>()
  // 当前模块接收热更新的模块合集 Set，元素是 ModuleNode 对象；和import.meta.hot.accept() 有关
  acceptedHmrDeps = new Set<ModuleNode>()
  acceptedHmrExports: Set<string> | null = null
  importedBindings: Map<string, Set<string>> | null = null
  // 和 import.meta.hot.accept() 有关 , 如果是模块自更新，则为 true
  isSelfAccepting?: boolean
  // code: 源码, map: sourcemap 相关,etag: 唯一值，和对比缓存有关
  transformResult: TransformResult | null = null
  ssrTransformResult: TransformResult | null = null
  ssrModule: Record<string, any> | null = null
  ssrError: Error | null = null
  // HMR 更新时间
  lastHMRTimestamp = 0
  lastInvalidationTimestamp = 0

  /**
   * @param setIsSelfAccepting - set `false` to set `isSelfAccepting` later. e.g. #7870
   */
  constructor(url: string, setIsSelfAccepting = true) {
    this.url = url
    this.type = isDirectCSSRequest(url) ? 'css' : 'js'
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false
    }
  }
}

function invalidateSSRModule(mod: ModuleNode, seen: Set<ModuleNode>) {
  if (seen.has(mod)) {
    return
  }
  seen.add(mod)
  mod.ssrModule = null
  mod.ssrError = null
  mod.importers.forEach((importer) => invalidateSSRModule(importer, seen))
}

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined,
]
// 将传入的插件容器container挂载到this上，
// 并初始化 4 个属性urlToModuleMap、idToModuleMap、fileToModulesMap、safeModulesPath
export class ModuleGraph {
  // 某一个模块的在客户端引入的url与模块之间的对应关系
  urlToModuleMap = new Map<string, ModuleNode>()
  // resolveId钩子接收到的id与模块之间的对应关系
  idToModuleMap = new Map<string, ModuleNode>()
  // a single file may corresponds to multiple modules with different queries
  // 文件名与模块之间的对应关系 这三个存储的内容几乎是一致的，只不过key不一样
  fileToModulesMap = new Map<string, Set<ModuleNode>>()
  safeModulesPath = new Set<string>()

  constructor(
    private resolveId: (
      url: string,
      ssr: boolean,
    ) => Promise<PartialResolvedId | null>,
  ) {}
  // 根据 url 获取模块对应的 ModuleGraph 对象
  async getModuleByUrl(
    rawUrl: string,
    ssr?: boolean,
  ): Promise<ModuleNode | undefined> {
    const [url] = await this.resolveUrl(rawUrl, ssr)
    return this.urlToModuleMap.get(url)
  }
  // 根据 id 获取模块对应的 ModuleGraph 对象
  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }
  // 根据 文件 获取模块对应的 ModuleGraph 对象集合 Set
  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }
  // 根据传入的file获取并清空对应ModuleNode对象的transformResult属性值
  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      const seen = new Set<ModuleNode>()
      mods.forEach((mod) => {
        // 将模块变为不可用
        this.invalidateModule(mod, seen)
      })
    }
  }
  // 清空 ModuleGraph 对象的 transformResult
  invalidateModule(
    mod: ModuleNode,
    seen: Set<ModuleNode> = new Set(),
    timestamp: number = Date.now(),
  ): void {
    // Save the timestamp for this invalidation, so we can avoid caching the result of possible already started processing being done for this module
    // 保存此无效的时间戳，这样我们就可以避免缓存对该模块可能已启动的处理的结果
    // 这个跟时间有关吗
    mod.lastInvalidationTimestamp = timestamp
    // Don't invalidate mod.info and mod.meta, as they are part of the processing pipeline
    // Invalidating the transform result is enough to ensure this module is re-processed next time it is requested
    mod.transformResult = null
    mod.ssrTransformResult = null
    // 处理ssr相关模块
    invalidateSSRModule(mod, seen)
  }
  // 清空所有 ModuleGraph 对象的 transformResult
  invalidateAll(): void {
    const timestamp = Date.now()
    const seen = new Set<ModuleNode>()
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp)
    })
  }

  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   */
  // 用于构建和更新模块之间的引用关系
  // 主要会被外部调用的方法
  async updateModuleInfo(
    mod: ModuleNode, // 当前模块对应的 ModuleNode 对象
    importedModules: Set<string | ModuleNode>,// 当前模块导入的模块
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | ModuleNode>,// 当前模块接收热更新模块的合集，当前模块变化后，会执行这些模块的热更新
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean,// 如果是自身更新则为 true，ssr相关
    ssr?: boolean,
  ): Promise<Set<ModuleNode> | undefined> {
    debugger
    // 如果为 true，表示接收模块自身的热更新
    mod.isSelfAccepting = isSelfAccepting
    // 获取该模块之前导入集合
    const prevImports = mod.importedModules
    // 创建新的 Set，表明新的引入的模块
    const nextImports = (mod.importedModules = new Set())
    // 不再引入的模块
    let noLongerImported: Set<ModuleNode> | undefined
    // update import graph
    // 遍历 importedModules
    for (const imported of importedModules) {
      // 如果 imported 是字符串则为依赖模块创建/查找 ModuleNode 实例
      const dep =
        typeof imported === 'string'
          ? await this.ensureEntryFromUrl(imported, ssr)
          : imported
      // 将当前模块的 ModuleNode 实例添加到依赖模块对应的 ModuleNode 实例的 importers 上
      dep.importers.add(mod)
      // 将这个依赖模块对应的 ModuleNode 实例添加到 nextImports 中
      nextImports.add(dep)
    }
    // remove the importer from deps that were imported but no longer are.
    prevImports.forEach((dep) => {
      // 如果 nextImports 中没有这个 dep
      // 说明这个 dep 对应的模块没在当前模块中导入
      // 所以将 mod 从 dep 的 dep.importers 中删除
      // 这个时候就看出set的好处了，需要删除的时候，能提升性能
      if (!nextImports.has(dep)) {
        dep.importers.delete(mod)
        if (!dep.importers.size) {
          // dependency no longer imported
          // 如果没有模块导入 dep 对应的模块，则收集到 noLongerImported 中
          ;(noLongerImported || (noLongerImported = new Set())).add(dep)
        }
      }
    })
    // update accepted hmr deps
    // 将 import.meta.hot.accept() 中设置的模块添加到 mod.acceptedModules 里面，不包含自身
    const deps = (mod.acceptedHmrDeps = new Set())
    for (const accepted of acceptedModules) {
      const dep =
        typeof accepted === 'string'
          ? await this.ensureEntryFromUrl(accepted, ssr)
          : accepted
      deps.add(dep)
    }
    // update accepted hmr exports
    mod.acceptedHmrExports = acceptedExports
    mod.importedBindings = importedBindings
    // 将当前模块导入过，现在没有任何模块导入的文件集合返回
    return noLongerImported
  }
  // 根据模块路径创建ModuleNode对象，将对象收集到ModuleGraph的属性中；最后返回这个对象
  // 添加到urlToModuleMap中，键是文件url；值是模块对应的MoudleNode对象
  // 添加到idToModuleMap中，键是文件绝对路径；值是模块对应的MoudleNode对象
  // 添加到fileToModulesMap中，键是去掉query和hash的文件绝对路径；值是Set实例，里面添加的是模块对应的MoudleNode对象
  // 主要会被外部调用的方法
  async ensureEntryFromUrl(
    rawUrl: string,
    ssr?: boolean,
    setIsSelfAccepting = true,
  ): Promise<ModuleNode> {
    const [url, resolvedId, meta] = await this.resolveUrl(rawUrl, ssr)
    let mod = this.idToModuleMap.get(resolvedId)
    if (!mod) {
      mod = new ModuleNode(url, setIsSelfAccepting)
      if (meta) mod.meta = meta
      // 一个url对应一个模块
      this.urlToModuleMap.set(url, mod)
      mod.id = resolvedId
      // 一个id对应一个模块
      this.idToModuleMap.set(resolvedId, mod)
      const file = (mod.file = cleanUrl(resolvedId))
      // 一个文件对应多个模块，这是由于一个文件是可能编译成多个文件的，比如.vue文件，分为template,script,style三个模块
      let fileMappedModules = this.fileToModulesMap.get(file)
      if (!fileMappedModules) {
        fileMappedModules = new Set()
        this.fileToModulesMap.set(file, fileMappedModules)
      }
      fileMappedModules.add(mod)
    }
    // multiple urls can map to the same module and id, make sure we register
    // the url to the existing module in that case
    else if (!this.urlToModuleMap.has(url)) {
      this.urlToModuleMap.set(url, mod)
    }
    return mod
  }

  // some deps, like a css file referenced via @import, don't have its own
  // url because they are inlined into the main css import. But they still
  // need to be represented in the module graph so that they can trigger
  // hmr in the importing css file.
  createFileOnlyEntry(file: string): ModuleNode {
    file = normalizePath(file)
    let fileMappedModules = this.fileToModulesMap.get(file)
    if (!fileMappedModules) {
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    const url = `${FS_PREFIX}${file}`
    for (const m of fileMappedModules) {
      if (m.url === url || m.id === file) {
        return m
      }
    }

    const mod = new ModuleNode(url)
    mod.file = file
    fileMappedModules.add(mod)
    return mod
  }

  // for incoming urls, it is important to:
  // 1. remove the HMR timestamp query (?t=xxxx)
  // 2. resolve its extension so that urls with or without extension all map to
  // the same module
  // 这个方法的作用是调用所有插件的resolveId钩子函数，根据当前被请求模块的url，获取该文件的绝对路径，最后返回[url, 文件绝对路径]
  async resolveUrl(url: string, ssr?: boolean): Promise<ResolvedUrl> {
    url = removeImportQuery(removeTimestampQuery(url))
    const resolved = await this.resolveId(url, !!ssr)
    const resolvedId = resolved?.id || url
    if (
      url !== resolvedId &&
      !url.includes('\0') &&
      !url.startsWith(`virtual:`)
    ) {
      const ext = extname(cleanUrl(resolvedId))
      // 如果url是相对路径，就会在头部加上relative://标识
      // 当然这个处理在4.3被废弃了，const pathname = cleanUrl(url)
      // url.slice(pathname.length) 通过这个函数就能得到 search + hash 的结果
      const { pathname, search, hash } = new URL(url, 'relative://')
      if (ext && !pathname!.endsWith(ext)) {
        url = pathname + ext + search + hash
      }
    }
    return [url, resolvedId, resolved?.meta]
  }
}
