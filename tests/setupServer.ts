/**
 * Read every chunk currently buffered on an SSE response body.
 *
 * @param response - Streaming response to drain until it closes or becomes idle
 * @returns The currently available decoded text
 */
export async function readAvailable(response: Response): Promise<string> {
	const reader = response.body?.getReader()
	if (reader === undefined) return ''
	const decoder = new TextDecoder()
	let text = ''
	const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
		setTimeout(() => resolve({ done: true, value: undefined }), 20),
	)
	while (true) {
		const result = await Promise.race([reader.read(), timeout])
		if (result.done) break
		text += decoder.decode(result.value, { stream: true })
	}
	reader.releaseLock()
	return text
}
