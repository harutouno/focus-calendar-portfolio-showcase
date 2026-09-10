import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import { AttachmentLimits } from "@/constants/attachmentLimits";
import { AttachmentErrorReason, ProcessedImage } from "@/types/attachment";

/**
 * 選択された1枚の画像を検証・向き補正・リサイズ・再エンコード・EXIF除去し、
 * 保存可能な ProcessedImage を作る画像処理パイプライン（フェーズ2）。
 *
 * 保存形式はJPEGへ統一する（既存のアバター/カバー画像も.jpg固定で運用されている慣習に合わせ、
 * 写真主体の用途でPNG/WebPよりファイルサイズ効率が良く、透過は今回の用途で不要なため）。
 * HEIC/HEIF専用の特別分岐は作らない——expo-image-manipulatorのネイティブデコーダが
 * HEIC/HEIFを読み込みJPEGとして書き出す標準機能をそのまま利用する。
 * renderAsync()/saveAsync()はデコード済みピクセルから新規ファイルを生成する再エンコード処理のため、
 * GPS等の元EXIFは設計上引き継がれない（実バイナリでの確認は実機検証項目とする）。
 * 画像の向きはネイティブデコーダがEXIFの向き情報を読み取って自動的に補正する
 * （expo-image-manipulatorの標準動作。手動でのrotate()呼び出しは行わない）。
 */

const SUPPORTED_SOURCE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export class AttachmentProcessingError extends Error {
  reason: AttachmentErrorReason;
  constructor(reason: AttachmentErrorReason) {
    super(reason);
    this.reason = reason;
  }
}

/** 品質を段階的に下げる試行順。無限ループを避けるため固定の有限配列にする。 */
const QUALITY_TIERS = [0.8, 0.65, 0.5];
/** 品質だけでは収まらない場合に、長辺の目標値をさらに段階的に下げる比率。 */
const RESOLUTION_TIER_RATIOS = [1, 0.75, 0.5];

export interface PickedImageInfo {
  uri: string;
  mimeType?: string | null;
  width: number;
  height: number;
}

/**
 * 圧縮ラダー: 解像度ティア×品質ティアを順に試し、最初に上限以下になった時点で返す。
 * 最大 RESOLUTION_TIER_RATIOS.length × QUALITY_TIERS.length 回（現状9回）の実エンコード試行で
 * 打ち切る（無限ループにしない）。全滅時は AttachmentProcessingError("too-large-after-compression")。
 */
export async function processPickedImage(
  picked: PickedImageInfo,
  limits: AttachmentLimits
): Promise<ProcessedImage> {
  const mimeType = (picked.mimeType ?? "").toLowerCase();
  if (mimeType && !SUPPORTED_SOURCE_MIME_TYPES.has(mimeType)) {
    throw new AttachmentProcessingError("unsupported-format");
  }

  // 長辺がどちらの辺かで指定する辺を切り替える（もう一方はアスペクト比を維持して自動計算される）。
  const isLandscape = picked.width >= picked.height;

  for (const ratio of RESOLUTION_TIER_RATIOS) {
    const targetLongEdge = Math.round(limits.maxLongEdge * ratio);
    let rendered;
    try {
      const context = ImageManipulator.manipulate(picked.uri);
      context.resize(isLandscape ? { width: targetLongEdge } : { height: targetLongEdge });
      rendered = await context.renderAsync();
    } catch {
      throw new AttachmentProcessingError("decode-failed");
    }

    for (const quality of QUALITY_TIERS) {
      const saved = await rendered.saveAsync({ compress: quality, format: SaveFormat.JPEG });
      const byteSize = new File(saved.uri).size;
      if (byteSize <= limits.maxBytesPerImage) {
        return {
          localUri: saved.uri,
          mimeType: "image/jpeg",
          byteSize,
          width: saved.width,
          height: saved.height,
        };
      }
    }
  }

  throw new AttachmentProcessingError("too-large-after-compression");
}
