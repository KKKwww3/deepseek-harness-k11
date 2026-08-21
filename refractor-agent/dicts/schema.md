# 折射词典 schema（员工维护）

**唯一维护文件：`dicts/refractions.yml`**。一行 = 向量库 `refractor_types` 表里的一条记录。
改完跑 `python scripts/embed.py` 自动重建向量库（自动校验，报错会说明哪行不对）。

## 一个折射条目

```yaml
- pattern: 碎冰            # 图案类型（新增即自动成为 VLM 枚举，无需单独维护枚举文件）
  color: 红                # 颜色（同上）
  keywords: [碎冰红, 红色碎冰, red ice, ice red]   # 别名/外观描述（向量匹配用，员工维护重点）
  names:                   # 对外叫法，按品牌×系列（同类型不同系列叫法不同）
    panini-prizm: {name: 碎冰红, name_en: Red Ice}
    topps-chrome: {name: 红折, name_en: Red}   # 该系列不卖就不用登记
```

## 各字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pattern` | str | 是 | 图案类型（自动入枚举，含 `平卡`/`其他` 系统值）|
| `color` | str | 是 | 颜色（自动入枚举，含 `无`/`其他` 系统值）|
| `keywords` | list[str] | 是 | 别名/变体/外观描述，员工维护重点（向量用）|
| `names` | dict | 推荐 | key=`品牌-系列`，value=`{name, name_en}`（对外标准名词）|

## 约束（embed.py 强校验）

1. `(pattern, color)` **全局唯一**（同图不同色 = 独立条目，碎冰银/碎冰红/碎冰蓝 各一条）；
2. `keywords` 非空；
3. `names` 里每个系列 key 必须给出 `name` 与 `name_en`。

> `names` 的 key 用 `品牌-系列` 小写（如 `panini-prizm`）。品牌/系列由 VLM 纯文本
> 识别稳定返回，无需别名表；员工只需保证 `names` 的 key 与 VLM 返回的 brand/series
> 一致（脚本会小写 + 去空白归一化）。

## 新增一个折射 = 两种方式

1. **手填**：在 `refractions` 里加一个条目，跑 `python scripts/embed.py`；
2. **命令**：`python scripts/add_type.py --pattern hyper --color 无 --series panini-prizm --name Hyper折 --name-en Hyper --keywords "hyper,海波折"`（自动写文件 + 重建）。

## 已登记的 品牌→系列

`panini-prizm`、`topps-chrome`（见各条目的 `names`）。
