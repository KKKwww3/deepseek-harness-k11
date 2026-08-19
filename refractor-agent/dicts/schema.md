# 折射映射词典 schema（员工维护）

每份词典是 `dicts/<brand>-<series>.yml`，一个品牌×系列一份。向量由
`scripts/embed.py` 自动生成，员工只维护本文件结构，不改数据库。

## 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `brand` | str | 品牌，小写（`panini` / `topps`）|
| `series` | str | 系列，小写（`prizm` / `chrome`）|
| `year` | int | 该年份系列（每份文件固定一年）|
| `refractions` | list | 折射规格列表，见下 |

## refraction 条目字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | str | 是 | 标准名词（对外中文，即客户搜索词）|
| `name_en` | str | 是 | 标准名词（英文）|
| `pattern` | str | 是 | 图案类型，必须取自受控枚举（见 refractor-vlm 技能）|
| `color` | str | 是 | 颜色，必须取自受控枚举；无则 `无` |
| `keywords` | list[str] | 是 | 员工补充的别名/变体写法，用于向量 embedding |

## 约束（embed.py 强校验）

1. **同图不同色 = 独立条目**：同一份文件里 `(pattern, color)` 必须唯一，
   冲突则报错。碎冰银 / 碎冰红 / 碎冰蓝 各自一条。
2. `pattern` / `color` 两个值与 refractor-vlm 的受控枚举一致，避免识别与
   匹配两边对不上。已在枚举但未出现在本系列词典的，员工可不登记。
3. 每条折射的向量由 `name / name_en / keywords` 生成（多词取平均）。

## 已登记 品牌→系列

```yaml
brand: panini
series: [prizm]
brand: topps
series: [chrome]
```

> 新品牌×系列：新建一份 `dicts/<brand>-<series>.yml`，并把 (brand, series)
> 追加到这里，embed.py 会自动扫描 `dicts/*.yml`。