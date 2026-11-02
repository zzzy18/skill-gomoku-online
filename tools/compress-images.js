/**
 * 图片压缩：按实际显示尺寸降采样 + 最优编码。
 *
 * 原图全是 1254×1254 这类大尺寸，但页面里最小的只显示 20×20，
 * 属于纯浪费。这里按「显示尺寸 × 2~3 倍 retina」定目标尺寸。
 */

'use strict';

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');

/**
 * 每张图的处理策略：
 *   width  — 目标宽度（height 按比例）
 *   palette— 是否量化到 256 色。简单图形（图标/棋子）用好，
 *            照片类（木纹）会产生色带，必须关掉。
 */
const PLAN = [
  // 页面里作 20px 图标用，96px 足够 4x retina
  { file: 'energy-orb-cartoon.png', width: 96, palette: true },
  // 未引用的备用素材，留个中等尺寸即可
  { file: 'energy-orb.png', width: 256, palette: true },
  // 标题 logo，页面显示宽度约 200~400px
  { file: 'skill-gomoku-logo.png', width: 776, palette: false },
  // 棋子纹理，canvas 上 540px 区域使用
  { file: 'gomoku-stones.png', width: 1024, palette: false },
  // 棋盘木纹背景，照片类，量化会出色带
  { file: 'board-wood.png', width: 900, palette: false },
];

function kb(n) {
  return (n / 1024).toFixed(0) + 'KB';
}

async function main() {
  console.log('');
  console.log('\x1b[1m图片压缩\x1b[0m');
  console.log('─'.repeat(64));
  console.log('文件'.padEnd(26) + '尺寸'.padEnd(20) + '体积');
  console.log('─'.repeat(64));

  let beforeTotal = 0;
  let afterTotal = 0;

  for (const item of PLAN) {
    const src = path.join(PUB, item.file);
    const tmp = path.join(PUB, '.' + item.file + '.tmp');

    if (!fs.existsSync(src)) {
      console.log(`  ${item.file} 不存在，跳过`);
      continue;
    }

    const before = fs.statSync(src).size;
    const meta = await sharp(src).metadata();

    // 保持宽高比；不放大（原图比目标小时保持原样）
    const pipeline = sharp(src).resize({
      width: item.width,
      withoutEnlargement: true,
      fit: 'inside',
    });

    const opts = {
      compressionLevel: 9,
      effort: 10,
      // 有 alpha 的保持 alpha
      ...(meta.hasAlpha ? {} : {}),
      ...(item.palette
        ? { palette: true, quality: 92, colours: 256, dither: 0.5 }
        : {}),
    };

    await pipeline.png(opts).toFile(tmp);

    const after = fs.statSync(tmp).size;
    // 只有真的变小才替换
    if (after < before) {
      fs.renameSync(tmp, src);
    } else {
      fs.unlinkSync(tmp);
    }

    const newMeta = await sharp(src).metadata();
    const finalSize = fs.statSync(src).size;
    beforeTotal += before;
    afterTotal += finalSize;

    const pct = ((1 - finalSize / before) * 100).toFixed(0);
    console.log(
      item.file.padEnd(26) +
        `${meta.width}x${meta.height} → ${newMeta.width}x${newMeta.height}`.padEnd(20) +
        `${kb(before)} → ${kb(finalSize)}  -${pct}%`
    );
  }

  console.log('─'.repeat(64));
  const totalPct = ((1 - afterTotal / beforeTotal) * 100).toFixed(0);
  console.log(
    '合计'.padEnd(26) +
      ''.padEnd(20) +
      `\x1b[1m${kb(beforeTotal)} → ${kb(afterTotal)}  -${totalPct}%\x1b[0m`
  );
  console.log('');
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});