# 折射词典 schema（员工维护）

词典分两层，均在 `dicts/` 下：

- `enum.yml` —— pattern/color 受控枚举（单一事实源，见下）
- `types.yml` —— **全局折射类型**：每个 `(pattern, color)` 只登记一次（跨品牌×系列共享），
  携带 keywords（别名/外观描述，向量匹配用）
- `series/<brand>-<series>.yml` —— **系列命名表**：本系列有哪些折射 + 对外标准名词

向量只从 `types.yml` 生成（每类型一条），命名从 `series/` 查表。无 `year`：折射规格
跨年份一致，命名复用所有年份。

## 全局类型表 types.yml

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pattern` | str | 是 | 图案类型，必须取自受控枚举（enum.yml）|
| `color` | str | 是 | 颜色，必须取自受控枚举；无则 `无` |
| `keywords` | list[str] | 是 | 别名/变体/外观描述（各系列叫法都可放这里，向量匹配用）|

约束（embed.py 强校验）：
1. `(pattern, color)` **全局唯一**；
2. `pattern` / `color` 必须在 `enum.yml` 内；
3. 新增折射种类：在 types.yml 登记 + 在需要的系列命名表登记。

## 系列命名表 series/<brand>-<series>.yml

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `brand` | str | 是 | 品牌，小写（`panini` / `topps`）|
| `series` | str | 是 | 系列，小写（`prizm` / `chrome`）|
| `names` | list | 是 | 本系列折射的对外叫法，见下 |

name 条目字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pattern` | str | 是 | 必须已在 types.yml 登记 |
| `color` | str | 是 | 必须已在 types.yml 登记 |
| `name` | str | 是 | 标准名词（对外中文，即客户搜索词）|
| `name_en` | str | 是 | 标准名词（英文）|

约束（embed.py 强校验）：
1. 同系列内 `(pattern, color)` 必须唯一；
2. 每个 `(pattern, color)` 必须已在 types.yml 登记（该系列不卖的折射不要登记）。

## 已登记 品牌→系列

```yaml
brand: panini
series: [prizm]
brand: topps
series: [chrome]
```

> 新增品牌×系列：新建 `series/<brand>-<series>.yml`，并确保其中每个 (pattern,color)
> 都已在 `types.yml` 登记（未登记的补进 types.yml），embed.py 自动扫描。
