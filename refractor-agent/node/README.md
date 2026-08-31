# refractor-agent/node — Node/TS 移植

`refractor-agent` 脚本逻辑从 Python 向 Node/TS 的移植（运行时统一 + DSH 原生类型化工具的前置）。
Python 版本在移植完成前是**行为契约**：错误码、校验顺序、归一化、重试分类必须逐项一致。

## 当前进度

| 模块 | 状态 | 契约（Python 源） |
|---|---|---|
| `src/schemas.ts` | ✅ 已移植 | `scripts/schemas.py` |
| `src/env.ts` | ✅ 已移植 | `refract_store.load_env` |
| `src/store.ts` | ✅ 已移植 | `scripts/refract_store.py` |
| `src/dict.ts` | ✅ 已移植 | `scripts/embed.py`（核心函数） |
| `src/match.ts` | ✅ 已移植 | `scripts/match.py` |
| `src/embed.ts` | ✅ 已移植 | `scripts/embed.py`（CLI 含） |
| `src/evaluate.ts` | ✅ 已移植（match 模式） | `scripts/evaluate.py` |
| `src/vlm.ts` | ✅ 已移植 | `scripts/vlm.py`（重试分类/大小限制/双模式/图片归一化，CLI 含） |
| `src/jobStore.ts` + `src/batch.ts` | ✅ 已移植并加固 | `scripts/run_batch.py`（SQLite 事务状态机：lease、幂等键、冷却重试、事件审计；match 进程内调用；JSONL 降级为导出） |
| `src/tools.ts` + `src/dshPlugin.ts` | ✅ 已接线 | DSH 类型化工具层 + preset-carried function plugin（`dist/refractor-plugin.mjs`，preset 相对路径挂载；`tool-bash` 已移出业务主路径） |

## 金标双跑验收（第 2 步）

同一金标 + 同一 Python 构建的向量库，Python 与 TS 在阈值 0.5–0.9 各评一次，
metrics.json / errors.jsonl / confusion.json **逐项相等**（含 12 行明细与
`0.4167` 这类舍入值）。复跑方式：

```sh
# Python 侧建库后，两个运行时各跑一遍 evaluate，diff 输出目录即可
node src/evaluate.ts --mode match --golden ../eval/golden.yaml --db /tmp/py.lance --out /tmp/ts-eval
```

## 奇偶校验（parity）

`test/fixtures/parity.json` 由 Python 直接生成，TS 测试断言**逐位一致**：

- `localEmbed()` 与 Python `Embedder._local` 的两条 256 维向量完全相等；
- `dictFingerprint()` 与 Python 对真实词典的 SHA-1 完全相等（`40c35fc6…`）。

词典或哈希实现任何一侧变化，这里会立刻红。

## 命令

```sh
npm install          # 首次
npm test             # vitest run（50 个测试）
npm run typecheck    # tsc --noEmit
```

依赖：`@lancedb/lancedb`（官方 Node SDK，替代 Python lancedb）、`pg`（替代 psycopg）、`yaml`（替代 PyYAML）。

## 约定

- 本目录独立于仓库 pnpm workspace（`pnpm-workspace.yaml` 未覆盖），用 npm 自管 lockfile。
- 领域词典 `../dicts/*.yml`、金标 `../eval/golden.yaml` 与运行时无关，两种实现共用。
- Python 版在金标双跑对比通过并完成工具装配后退役。
