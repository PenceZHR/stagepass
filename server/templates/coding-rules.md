# Coding Rules

> 编码规范。在 .ship 初始化后请补充具体内容。

## 命名规范

- 文件：kebab-case
- 变量/函数：camelCase
- 类/接口：PascalCase
- 常量：UPPER_SNAKE_CASE

## 代码风格

- 使用 ESLint + Prettier
- 每个函数不超过 50 行
- 优先使用 async/await

## 测试规范

- 每个功能模块必须有单元测试
- 测试文件命名：`*.test.ts`
- 测试覆盖关键路径

## 禁止事项

- 禁止使用 any
- 禁止直接操作 DOM（如使用框架）
- 禁止在生产代码中使用 console.log
