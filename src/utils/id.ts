/**
 * 依存ライブラリを増やさないための簡易ID生成。
 * 第1工程のローカル保存用途では衝突リスクは無視できるレベル。
 */
export function generateId(prefix = "id"): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${random}`;
}
