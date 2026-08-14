# DOCX 真实文档双引擎验收

本清单用于完成 `v0.5.1` 发布前最后的 DOCX 兼容性门槛。自动化只证明源文件未变、两种输出可重新解析且分段结构一致；Microsoft Word 和 LibreOffice 的逐页视觉结论必须由人工记录。

## 1. 隐私与语料要求

- 至少 5 份已匿名化、允许本机测试的真实 `.docx`，不得包含账号、密钥、客户原文、个人身份信息或未授权内容。
- 覆盖正文/标题/超链接、列表、表格或嵌套表格、多节页眉页脚、图片/字段和复杂 Unicode；无法由单份文档覆盖时可在 5 份以上语料间组合。
- 语料、输出和检查记录放在项目根目录 `.docx-acceptance/`；该目录已被 Git 忽略，不得强制加入版本库。
- 开始前记录全部源文件 SHA-256；成功、失败和取消后重新核对。

建议结构：

```text
.docx-acceptance/
├── manifest.json
├── docs/
│   ├── case-01.docx
│   ├── case-02.docx
│   ├── case-03.docx
│   ├── case-04.docx
│   ├── case-05.docx
│   └── encrypted.docx
└── review.md
```

`manifest.json` 沿用导入验收格式：

```json
{
  "cases": [
    {
      "file": "case-01.docx",
      "expectedSourceText": ["按 Word 可见顺序记录的第一段", "第二段"],
      "expectedWarnings": []
    }
  ],
  "encryptedFile": "encrypted.docx"
}
```

## 2. 导入与真实 round-trip

在 PowerShell 中执行：

```powershell
$env:DOCX_VALIDATION_MANIFEST = (Resolve-Path '.docx-acceptance/manifest.json').Path
cargo test --manifest-path src-tauri/Cargo.toml validates_rendered_docx_corpus_manifest -- --ignored --nocapture

$acceptanceRoot = (Resolve-Path '.docx-acceptance').Path
$env:DOCX_ROUNDTRIP_OUTPUT_DIR = Join-Path $acceptanceRoot ("outputs-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
cargo test --manifest-path src-tauri/Cargo.toml round_trips_real_validation_corpus_for_visual_review -- --ignored --nocapture
```

第二条测试要求输出目录尚不存在，并为每份语料生成 `*-translated.docx` 与 `*-bilingual.docx`。它会重新打开成品、核对段数/部件/结构、在保留 Word 制表符和换行等布局控制的前提下验证译文占位内容，并确认源文件字节不变；不会删除输出，也不会自动填写人工结论。

## 3. Word 与 LibreOffice 逐页检查

每份源文档、译文版和双语版必须并排检查。`review.md` 至少记录以下矩阵：

| 文档 | 模式 | Word 打开 | LibreOffice 打开 | 文本完整/顺序 | 表格/列表/链接 | 图片/页眉页脚 | 明显降级与结论 |
|---|---|---|---|---|---|---|---|
| case-01 | 译文 | 待检查 | 待检查 | 待检查 | 待检查 | 待检查 | 待检查 |
| case-01 | 双语 | 待检查 | 待检查 | 待检查 | 待检查 | 待检查 | 待检查 |

检查要求：

1. 两个引擎均能打开且不提示修复或损坏。
2. 所有可见源段或译文占位段顺序正确，不静默丢失、重复或错位。
3. 表格、列表、链接、图片、分页、页眉页脚没有不可接受的结构变化。
4. 译文版不残留应替换的源文；双语版同时包含源文和译文，分隔清晰。
5. 字段、修订、公式、文本框等降级内容与导入警告一致，不把已知警告写成全面兼容。
6. 源文件 SHA-256 与开始前一致；输出目录没有 `.long-translate-*` 临时文件。

## 4. 退出门槛

- 至少 5 份真实文档 × 2 种模式 × 2 个引擎的检查均有记录。
- 没有未归类的损坏、丢段、错位、覆盖源文件或临时文件残留。
- 可接受降级写入 Release Notes；不可接受问题必须先修复并重新执行完整矩阵。
- 完成后只提交脱敏的覆盖范围、SHA-256 摘要和结论，不提交真实语料、输出文件或含正文的 `review.md`。
