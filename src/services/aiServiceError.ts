/**
 * AIサービスが投げる、ユーザーへそのまま見せてよい安全なメッセージだけを
 * 保持するエラー型。
 *
 * useAISupportRequestはこの型のインスタンスに限りmessageをそのまま表示し、
 * それ以外の予期しない例外は汎用メッセージへ丸める（内部詳細を漏らさないため）。
 */
export class AISupportServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AISupportServiceError";
  }
}
