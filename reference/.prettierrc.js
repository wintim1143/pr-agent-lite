module.exports = {
  // 用 auto 而非 crlf/lf。
  // auto = 文件当前是 CRLF 就保持 CRLF、是 LF 就保持 LF,prettier 不强制改行尾,
  // 因此 Windows 工作区存 CRLF 也不会报 Delete ␍;仓库层的换行统一交由 .gitattributes
  // (* text=auto eol=lf) 在 commit 时归一为 LF 入库。这样格式化后不会反复报警。
  endOfLine: 'auto',
  printWidth: 120,
  // 以下几项是按参考代码的既有风格补的(原实现继承自旧框架的 prettier 预设,预设本身未随副本提供),
  // 非实测配置。新项目可按自己偏好改写。
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'avoid',
};
