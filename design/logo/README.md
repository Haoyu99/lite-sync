# lite-sync 标志

定稿：**错位等号**（`mark-equal-v2.svg`）。圆角方块里镂空两条等长的横线，错开摆放：等号表示两边一致，横线也像笔记的两行。一个图形同时用作网页标志和浏览器标签图标。

| 文件 | 用途 |
|---|---|
| `mark-equal-v2.svg` | 标志源文件，颜色跟随 `currentColor` |
| `favicon.svg` | 浏览器标签图标，跟随系统浅色或深色 |
| `apple-touch-icon.svg` / `.png` | iOS 主屏图标（180 × 180） |

构造：256 网格；方块圆角 56；横线高 36、长 112、圆头，上下相距 20，左右错开 40，整体居中。16 px 时横线约 2.3 px、间隙约 1.3 px，仍然分得开。

`favicon.svg` 和 `apple-touch-icon.png` 已复制到 `packages/admin/public/`。导航栏标志在 `packages/admin/src/app.css` 的 `.wordmark::before` 里，用同一条路径做蒙版。修改标志时三处要一起改。
