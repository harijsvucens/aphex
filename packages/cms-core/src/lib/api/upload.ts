import { ApiError } from './client';
import type { ApiResponse } from './types';

/**
 * Uploads, on XMLHttpRequest rather than fetch.
 *
 * Not nostalgia: `fetch` has no upload progress event. Request body streams are
 * the standards-track answer and are still neither broadly supported nor usable
 * with a plain `FormData`, so XHR remains the only way to report how far a
 * multi-megabyte upload has actually got. Everything else here exists to make
 * that swap invisible — same `ApiResponse`, same `ApiError`, same defensive
 * parsing — so callers can't tell which transport ran.
 */

export interface UploadOptions {
	/** Called with 0–100 as the body is sent. Never called after completion. */
	onProgress?: (percent: number) => void;
	/** Aborts the upload. The promise rejects with an `ApiError` of status 0. */
	signal?: AbortSignal;
	/** Milliseconds of inactivity before giving up. */
	timeoutMs?: number;
}

/**
 * A direct-to-storage write the server has already authorized.
 *
 * Mirrors `DirectUploadGrant` from the storage interface without importing it:
 * this module runs in the browser and the interface barrel carries server types.
 */
export interface StorageUploadTarget {
	url: string;
	method?: 'PUT' | 'POST';
	headers?: Record<string, string>;
	fields?: Record<string, string>;
}

/**
 * XHR plumbing shared by the PUT (raw body) and POST (multipart) grants.
 *
 * `failureHint` is what the caller sees when the browser reports a bare network
 * error: cross-origin failures are deliberately opaque, so naming the likely
 * cause is the only way an operator finds a missing CORS rule.
 */
function sendXhr(
	method: 'PUT' | 'POST',
	url: string,
	body: File | Blob | FormData,
	headers: Record<string, string>,
	options: UploadOptions,
	failureHint: string
): Promise<void> {
	const { onProgress, signal, timeoutMs } = options;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new ApiError(0, null, 'Upload cancelled'));
			return;
		}

		const xhr = new XMLHttpRequest();
		xhr.open(method, url, true);
		xhr.withCredentials = false;
		for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
		if (timeoutMs) xhr.timeout = timeoutMs;

		if (onProgress) {
			xhr.upload.addEventListener('progress', (event) => {
				if (event.lengthComputable && event.total > 0) {
					onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
				}
			});
		}

		const onAbort = () => xhr.abort();
		signal?.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => signal?.removeEventListener('abort', onAbort);

		xhr.addEventListener('load', () => {
			cleanup();
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
				return;
			}
			// Providers explain refusals in the body (Cloudinary:
			// `{"error":{"message":"Invalid Signature ..."}}`). A bare status turns
			// a one-line fix into a debugging session, so surface it when present.
			let detail = `Storage rejected the upload (${xhr.status})`;
			try {
				const parsed = JSON.parse(xhr.responseText) as {
					error?: { message?: string } | string;
					message?: string;
				};
				const fromError = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
				detail = fromError || parsed.message || detail;
			} catch {
				// Non-JSON error page; keep the status.
			}
			reject(new ApiError(xhr.status, null, detail));
		});

		xhr.addEventListener('error', () => {
			cleanup();
			reject(new ApiError(0, null, failureHint));
		});

		xhr.addEventListener('timeout', () => {
			cleanup();
			reject(new ApiError(0, null, 'Upload timed out'));
		});

		xhr.addEventListener('abort', () => {
			cleanup();
			reject(new ApiError(0, null, 'Upload cancelled'));
		});

		xhr.send(body);
	});
}

const PUT_FAILURE =
	'Could not reach storage. The bucket may not allow PUT from this origin (CORS).';
const POST_FAILURE =
	'Could not reach the upload service. It may not allow POST from this origin (CORS).';

/**
 * PUT a file straight to object storage, reporting progress.
 *
 * Distinct from {@link uploadFormData} in two ways that matter:
 *
 * - **No credentials.** The target is a third-party origin and the URL already
 *   carries its own signature. Sending cookies would leak the session to the
 *   storage provider and trip CORS besides.
 * - **Raw body, not FormData.** The signature covers the object bytes; wrapping
 *   them in multipart framing would store the framing.
 */
export function putToStorage(
	url: string,
	file: File | Blob,
	headers: Record<string, string> = {},
	options: UploadOptions = {}
): Promise<void> {
	return sendXhr('PUT', url, file, headers, options, PUT_FAILURE);
}

/**
 * Redeem a direct-upload grant, in whichever shape the adapter issued.
 *
 * A POST grant becomes a multipart body: the signed fields first, then the file
 * under `file` — the part name every provider's upload API expects. No
 * Content-Type header is set, because the browser must add the multipart
 * boundary itself.
 */
export function sendToStorage(
	target: StorageUploadTarget,
	file: File | Blob,
	options: UploadOptions = {}
): Promise<void> {
	const method = target.method ?? 'PUT';
	if (method === 'POST') {
		const form = new FormData();
		for (const [name, value] of Object.entries(target.fields ?? {})) form.append(name, value);
		form.append('file', file, file instanceof File ? file.name : 'upload');
		return sendXhr('POST', target.url, form, target.headers ?? {}, options, POST_FAILURE);
	}
	return sendXhr('PUT', target.url, file, target.headers ?? {}, options, PUT_FAILURE);
}

export function uploadFormData<T>(
	url: string,
	body: FormData,
	options: UploadOptions = {}
): Promise<ApiResponse<T>> {
	const { onProgress, signal, timeoutMs } = options;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new ApiError(0, null, 'Upload cancelled'));
			return;
		}

		const xhr = new XMLHttpRequest();
		xhr.open('POST', url, true);
		// Deliberately not setting Content-Type: the browser must add the
		// multipart boundary, and setting it by hand produces a body the server
		// cannot parse.
		xhr.withCredentials = true;
		if (timeoutMs) xhr.timeout = timeoutMs;

		if (onProgress) {
			xhr.upload.addEventListener('progress', (event) => {
				// `lengthComputable` is false when the size isn't known up front;
				// reporting a fabricated percentage would be worse than none.
				if (event.lengthComputable && event.total > 0) {
					onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
				}
			});
		}

		const onAbort = () => xhr.abort();
		signal?.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => signal?.removeEventListener('abort', onAbort);

		xhr.addEventListener('load', () => {
			cleanup();

			// Parse defensively, for the same reason the fetch client does: a
			// proxy or serverless platform can reject the request before it
			// reaches the app and answer with HTML, and parsing first would throw
			// a syntax error that buries the real status.
			let data: ApiResponse<T> | null = null;
			try {
				data = JSON.parse(xhr.responseText) as ApiResponse<T>;
			} catch {
				// Left null; handled below.
			}

			const ok = xhr.status >= 200 && xhr.status < 300;
			if (!ok) {
				reject(
					new ApiError(
						xhr.status,
						data,
						data?.message || data?.error || `Upload failed (${xhr.status})`
					)
				);
				return;
			}
			if (!data) {
				reject(new ApiError(xhr.status, null, 'Malformed response from server'));
				return;
			}
			if (!data.success) {
				reject(new ApiError(xhr.status, data, data.message || data.error));
				return;
			}

			resolve(data);
		});

		xhr.addEventListener('error', () => {
			cleanup();
			// XHR reports network failures with no detail at all, by design —
			// exposing more would leak cross-origin information.
			reject(new ApiError(0, null, 'Network error during upload'));
		});

		xhr.addEventListener('timeout', () => {
			cleanup();
			reject(new ApiError(0, null, 'Upload timed out'));
		});

		xhr.addEventListener('abort', () => {
			cleanup();
			reject(new ApiError(0, null, 'Upload cancelled'));
		});

		xhr.send(body);
	});
}
