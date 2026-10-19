# 打包成单文件 exe

产物：`AwesEvo.exe`（约 84MB，内含 Node 运行时 + 22 个源码文件）。

## 构建步骤

```bash
# 1. 生成资源清单（把 server/、web/、package.json 列成 assets）
python build/gen-config.py          # 输出 build/sea-config.json

# 2. 生成 SEA blob
node --experimental-sea-config build/sea-config.json

# 3. 注入（postject 装在工作区 node_modules，不进项目依赖）
cp "$(which node)" build/AwesEvo.exe
npx postject build/AwesEvo.exe NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 4. 把 PE Subsystem 从 3(控制台) 改成 2(窗口)，双击就不再弹黑框
python build/make-gui.py            # 原地修改 build/AwesEvo.exe
```

## 原理

`launcher.cjs` 作为 SEA 的入口（必须是 CJS）：

1. 探测 `exe 同级/server/index.js`：存在则 **portable** 直接用；
   否则把内嵌源码释放到 `%LOCALAPPDATA%\AwesEvo\app`
2. `await import()` 加载磁盘上的 ESM 入口，调导出的 `startServer()`
   —— SEA 只要求入口是 CJS，动态 ESM 加载不受限，业务代码无需 bundle
3. 用 Edge/Chrome 的 `--app=` 开无地址栏窗口（`detached` + `unref`）
4. 端口已被占用则直接拉起窗口并退出，不重复启动
5. 关窗判定用**连接数**而非子进程退出事件（Edge 主进程会立刻转交后退出）

## 注意

- `data/` 不打包，Key 不会进 exe
- 日志写 `data/app.log`，在设置 → 后台查看
- 改完 launcher 或任何源码后都要重跑全部 4 步
