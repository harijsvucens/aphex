import { describe, it, expect } from 'vitest';
import { AssetService } from '../src/lib/services/asset-service';
import type { Asset } from '../src/lib/types/asset';
import type { ImageDeliveryProvider } from '../src/lib/images/variants';

/**
 * Injection is the only place a document learns an image's URL, so these cases
 * are the whole contract between an external image provider and the built-in
 * `/media` route: when the provider may speak, and when it must stay quiet.
 */
const asset = (overrides: Partial<Asset> = {}): Asset =>
	({
		id: 'asset-1',
		organizationId: 'org-1',
		assetType: 'image',
		filename: 'original.jpg',
		originalFilename: 'photo.jpg',
		mimeType: 'image/jpeg',
		size: 1234,
		url: '/media/asset-1/photo.jpg',
		path: 'site/assets/asset-1/original.jpg',
		storageAdapter: 'cloudinary',
		width: 1200,
		height: 800,
		metadata: {},
		...overrides
	}) as Asset;

function service(
	document: Asset,
	provider: ImageDeliveryProvider,
	resolvePrivacy?: () => boolean | null,
	storageName = 'cloudinary'
): AssetService {
	const database = {
		findManyAssetsAdvanced: async () => ({ docs: [document] })
	} as unknown as ConstructorParameters<typeof AssetService>[1];
	return new AssetService(
		{ name: storageName } as ConstructorParameters<typeof AssetService>[0],
		database,
		{ widths: [320, 640, 960], quality: 80, provider },
		['image/jpeg', 'image/svg+xml'],
		resolvePrivacy
	);
}

const provider: ImageDeliveryProvider = {
	url: (a, widths) => `https://cdn.example/${a.id}?w=${widths[widths.length - 1]}`,
	srcset: (a, widths) => widths.map((w) => `https://cdn.example/${a.id}?w=${w} ${w}w`).join(', ')
};

async function injected(document: Asset, svc: AssetService) {
	const page = { cover: { asset: { _ref: document.id } } };
	await svc.injectAssetUrls('org-1', page);
	return page.cover.asset as { url?: string; srcset?: string };
}

describe('image delivery provider', () => {
	it('addresses a public image through the provider', async () => {
		const doc = asset();
		const result = await injected(doc, service(doc, provider));

		expect(result.url).toBe('https://cdn.example/asset-1?w=960');
		expect(result.srcset).toBe(
			[
				'https://cdn.example/asset-1?w=320 320w',
				'https://cdn.example/asset-1?w=640 640w',
				'https://cdn.example/asset-1?w=960 960w',
				// `src` stays an optimized rung; the srcset gains the native width so
				// a 2x display is not left asking for 1200 and getting 960.
				'https://cdn.example/asset-1?w=1200 1200w'
			].join(', ')
		);
	});

	it('offers a small original instead of ladder steps it cannot fill', async () => {
		const doc = asset({ width: 500 });
		const result = await injected(doc, service(doc, provider));

		expect(result.srcset).toBe(
			['https://cdn.example/asset-1?w=320 320w', 'https://cdn.example/asset-1?w=500 500w'].join(
				', '
			)
		);
	});

	it('keeps a private field on /media, where access is enforced', async () => {
		const doc = asset();
		const result = await injected(
			doc,
			service(doc, provider, () => true)
		);

		expect(result.url).toBe('/media/asset-1/photo.jpg');
		expect(result.srcset).toContain('/media/asset-1/');
		expect(result.srcset).not.toContain('cdn.example');
	});

	it('falls back for a source no derivative can be made from', async () => {
		const doc = asset({ mimeType: 'image/svg+xml' });
		const result = await injected(doc, service(doc, provider));

		expect(result.url).toBe('/media/asset-1/photo.jpg');
		expect(result.srcset).toBeUndefined();
	});

	it('falls back for a row stored by a different adapter', async () => {
		const doc = asset({ storageAdapter: 's3' });
		const result = await injected(doc, service(doc, provider, undefined, 'cloudinary'));

		expect(result.url).toBe('/media/asset-1/photo.jpg');
		expect(result.srcset).not.toContain('cdn.example');
	});

	it('falls back when the provider declines an asset', async () => {
		const doc = asset();
		const declining: ImageDeliveryProvider = { url: () => null, srcset: () => null };
		const result = await injected(doc, service(doc, declining));

		expect(result.url).toBe('/media/asset-1/photo.jpg');
		expect(result.srcset).toContain('/media/asset-1/');
	});
});
