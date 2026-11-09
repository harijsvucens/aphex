import { describe, expect, it } from 'vitest';
import { imageUrlBuilder } from '../src/lib/utils/image-url';

const cloudinarySrcset = [
	'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,c_limit,w_640/site/assets/a/original 640w',
	'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,c_limit,w_1280/site/assets/a/original 1280w'
].join(', ');

describe('imageUrlBuilder', () => {
	it('keeps commas inside a provider URL when snapping to a rung', () => {
		expect(imageUrlBuilder()({ srcset: cloudinarySrcset }).width(1200).url()).toBe(
			'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,c_limit,w_1280/site/assets/a/original'
		);
	});

	it('still snaps a built-in /media srcset', () => {
		const srcset = '/media/abc/w320-hash.webp 320w, /media/abc/w640-hash.webp 640w';
		expect(imageUrlBuilder()({ srcset }).width(500).url()).toBe('/media/abc/w640-hash.webp');
	});
});
