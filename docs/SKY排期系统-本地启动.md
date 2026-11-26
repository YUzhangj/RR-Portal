# SKY 排期系统本地启动

上传排期表（.xlsx）和 PO PDF，核对 Sky Castle、TOMY 或 Jazwares 的识别结果后，可下载更新后的排期表。

使用包含 [SKY 排期系统实现（#1149）](https://github.com/charlesskl/RR-Portal/pull/1149) 的代码版本，安装 Node.js 22.13 或更高的受支持版本。从仓库根目录执行：

```sh
cd 'apps/业务部/SKY排期系统'
npm ci
npm start
```

打开 [本地排期系统](http://127.0.0.1:3200/)。服务默认仅监听本机，上传文件和识别历史默认保存在应用目录下的 `data/`，也可通过 `DATA_PATH` 指定目录。
