# 签发生词 TSV 导出 License

使用 Node.js 22+，无需安装依赖。在仓库根目录执行以下命令。

## 生成管理员密钥

**私钥、seed 和任何签名材料都不得提交到 Git、放进 README、测试夹具或浏览器包。** 私钥必须保存在仓库外。

```sh
node packages/license-cli/sign.mjs --generate
```

默认私钥路径为 `~/.config/interlinear-reader/license-key.json`。CLI 以 `0600` 权限创建私钥文件，以 `0700` 创建新的父目录，只输出文件路径和公钥。文件已存在时拒绝覆盖。保存私钥的安全离线备份，不要重新生成已部署公钥对应的密钥。

把命令输出的 **public key** 写入 `packages/web/src/vocab/license.ts` 的 `LICENSE_PUBLIC_KEY`，然后构建网页。当前部署公钥已生成并嵌入；不要为了签发下一张 License 更换公钥。

如需自选路径，生成和签发时都传入仓库外路径：

```sh
node packages/license-cli/sign.mjs --generate --key "$HOME/.config/interlinear-reader/custom-license-key.json"
node packages/license-cli/sign.mjs --name Alice --plan vocab --years 1 --key "$HOME/.config/interlinear-reader/custom-license-key.json"
```

CLI 拒绝仓库内路径和指向仓库的父目录符号链接。`.gitignore` 额外忽略 `license-key*`、`license-private-key*` 和本地 `.config/interlinear-reader/`，但忽略规则不能代替仓库外存储。

## 签发并交付 License

```sh
node packages/license-cli/sign.mjs --name Alice --plan vocab --years 1
```

标准输出只有 License token。`--plan vocab` 对应签名载荷中的 `vocab-export`；`--years` 为 1–100 的整数，默认 1，按签发时刻的 UTC 年份计算。客户标签最多 1000 个 UTF-8 字节，是可解码的明文，不要填写敏感信息。将 token 私下交付客户，不要把有效 token 放进仓库或公开截图。

让客户打开网页 **生词 → 导出 TSV（Anki）· 需 License**，粘贴 token，再点击 **校验**。License 只保存在该站点的本地浏览器存储，清理存储后需重新输入。JSON 导出免费。

## Token 格式

```text
base64url(UTF8(JSON({plan:"vocab-export",exp:"2027-09-17T00:00:00.000Z",name:"Alice"}))).base64url(signature)
```

Ed25519 签名覆盖点号之前的 **base64url 字符串的 UTF-8 字节**，不是解码后的 JSON。两段都不带 `=` padding。以下仅展示形状，假签名不能解锁：

```text
eyJwbGFuIjoidm9jYWItZXhwb3J0IiwiZXhwIjoiMjAyNy0wOS0xN1QwMDowMDowMC4wMDBaIiwibmFtZSI6IkFsaWNlIn0.FAKE_SIGNATURE
```

设计、兼容性和验证记录见 [License TSV 导出设计](../../docs/research/license-tsv-export.md)。
