/**
 * Jest 配置。
 *
 * 三条与「照搬就会踩」直接相关的设置：
 *  1. `setupFiles` —— 把结构化日志的落盘路径从生产日志挪到临时目录。
 *     否则单测会往作为「证据」的日志里混事件，污染判据（原因见 test/jest.setup.ts 注释）。**必须保留。**
 *  2. `moduleNameMapper` —— 源码相对 import 因 tsconfig `module: NodeNext` 必须带 `.js` 后缀
 *     （如 `from './guard.js'`），而 jest/ts-jest 不会自动把 `.js` 回退解析到 `.ts`。
 *  3. `testPathIgnorePatterns` —— `.tmp/` 下的一次性验证脚本不是测试，不能被收集。
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testPathIgnorePatterns: ['<rootDir>/test/fixtures', '<rootDir>/test/jest.setup.ts', '<rootDir>/.tmp/'],
  coveragePathIgnorePatterns: ['<rootDir>/test/', '<rootDir>/.tmp/'],
};
