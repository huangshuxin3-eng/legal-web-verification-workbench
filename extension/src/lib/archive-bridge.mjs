/**
 * Worker archive 的可测试边界：保留真实 queryId → Query context → Capture
 * upload → 业务文件名 wiring，不包含 Chrome/PDF 或服务端归档协议实现。
 */
export function createArchiveBridge({
  queryContext,
  queryNotAccessibleCode,
  uploadCapture,
  captureName,
}) {
  return {
    async loadContext(queryId, unavailableMessage) {
      try {
        return await queryContext(queryId);
      } catch (error) {
        if (error?.code !== queryNotAccessibleCode) throw error;
        throw new Error(unavailableMessage || error.message);
      }
    },

    async upload({ queryId, queryRow, sourceUrl, requestId, blob }) {
      const capture = await uploadCapture(queryId, sourceUrl, requestId, blob);
      return {
        capture,
        filename: captureName(
          queryRow.tasks,
          queryRow.query_no,
          capture.capture_no,
          capture.created_at,
        ),
      };
    },
  };
}
