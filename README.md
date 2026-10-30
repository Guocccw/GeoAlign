# GeoAlign

JPG/PNG 平面图与 GeoJSON 的配准工具。目标是通过人工控制点和 OpenCV 自动精修，生成适合 Web/Canvas 渲染的“原图 + 配准 JSON + world file”导出包。

## 功能

- 导入 JPG/PNG 平面图和 GeoJSON。
- 左右两侧画布分别选择图片控制点和 GeoJSON 对应点。
- 3 对及以上控制点自动求解仿射变换。
- 显示 RMS 残差、最大残差和每个控制点残差。
- 在平面图上实时叠加配准后的 GeoJSON 轮廓。
- 后端导出配准包：原始图片、`geoalign.json`、`.jgw/.pgw` world file。
- 支持保持 GeoJSON 经纬度坐标、经纬度转 EPSG:3857、自定义 Proj4。


## 卫星比对 / 平移校正

配准完成后，点顶部「卫星比对 / 平移」：

- 底图是 Esri World Imagery（WGS84 / EPSG:3857），与 `transform` 同一坐标系，不需要 GCJ-02 纠偏。
- CAD 以「仅线稿（透明底）」叠加在卫星影像上，默认 55% 透明度。
- 默认「拖动 CAD」：直接拖图，ΔE/ΔN 实时变化；也可用方向键（±1 m）、Shift+方向键（±10 m）或右侧输入框。
- 确认后点「应用平移」，再点「后端导出配准包」。导出会把 ΔE/ΔN 同时写入 `transform`、world file、`controlPoints` 和 `segments`，保证包内一致。
- 「平移清零」回到当前包的原始位置；「适配 CAD」按 GeoJSON 范围回到整图。
- 「加载导出包」页也有同样的「卫星比对」入口：加载 zip 后可直接比对，点「导出修正包」把平移写回 zip。

注意：这里的 ΔE/ΔN 是**在当前包 transform 基础上的增量**。如果加载的是已经平移过的包，ΔE=0 就是该包的位置。

## 使用

```bash
pnpm install
pnpm dev
```

自动精修需要额外启动本地 OpenCV 服务：

```bash
pnpm backend:setup
pnpm backend
```

打开本地地址后：

1. 导入 JPG/PNG 平面图。
2. 导入 GeoJSON。
3. 点击“添加控制点”。
4. 在左侧图片点一个明显位置，在右侧 GeoJSON 点同一个真实位置。
5. 至少重复 3 对点，建议使用 4 到 8 对分布在图面四周和中部的点。
6. 点击“自动精修”，由本地 Python/OpenCV 根据 JPG 边缘和 GeoJSON 线稿自动优化仿射矩阵。
7. 观察 RMS/最大残差，删除偏差大的点后重新点选。
8. 点击“后端导出配准包”，得到 zip，里面包含原图、`geoalign.json` 和 world file。

## 说明

- 当前导出是仿射配准，适合平移、旋转、缩放、剪切这类平面图对齐。
- 自动精修接口固定为 `http://127.0.0.1:8765/refine`，必须先启动 `pnpm backend`。
- 后端导出接口固定为 `http://127.0.0.1:8765/export`，不会把 JPG 重写成巨大的未压缩 TIF。
- 如果 JPG 本身存在严重透视畸变或局部拉伸，需要后续增加二阶多项式或 TPS 配准。
