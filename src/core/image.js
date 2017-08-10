/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  assert, FormatError, ImageKind, info, isArray, warn
} from '../shared/util';
import { DecodeStream, JpegStream } from './stream';
import { isStream, Name } from './primitives';
import { ColorSpace } from './colorspace';
import { JpxImage } from './jpx';

var PDFImage = (function PDFImageClosure() {
  /**
   * Decodes the image using native decoder if possible. Resolves the promise
   * when the image data is ready.
   */
  function handleImageData(image, nativeDecoder) {
    if (nativeDecoder && nativeDecoder.canDecode(image)) {
      return nativeDecoder.decode(image);
    }
    return Promise.resolve(image);
  }

  /**
   * Decode and clamp a value. The formula is different from the spec because we
   * don't decode to float range [0,1], we decode it in the [0,max] range.
   */
  function decodeAndClamp(value, addend, coefficient, max) {
    value = addend + value * coefficient;
    // Clamp the value to the range
    return (value < 0 ? 0 : (value > max ? max : value));
  }

  /**
   * Resizes an image mask with 1 component.
   * @param {TypedArray} src - The source buffer.
   * @param {Number} bpc - Number of bits per component.
   * @param {Number} w1 - Original width.
   * @param {Number} h1 - Original height.
   * @param {Number} w2 - New width.
   * @param {Number} h2 - New height.
   * @returns {TypedArray} The resized image mask buffer.
   */
  function resizeImageMask(src, bpc, w1, h1, w2, h2) {
    var length = w2 * h2;
    var dest = (bpc <= 8 ? new Uint8Array(length) :
      (bpc <= 16 ? new Uint16Array(length) : new Uint32Array(length)));
    var xRatio = w1 / w2;
    var yRatio = h1 / h2;
    var i, j, py, newIndex = 0, oldIndex;
    var xScaled = new Uint16Array(w2);
    var w1Scanline = w1;

    for (i = 0; i < w2; i++) {
      xScaled[i] = Math.floor(i * xRatio);
    }
    for (i = 0; i < h2; i++) {
      py = Math.floor(i * yRatio) * w1Scanline;
      for (j = 0; j < w2; j++) {
        oldIndex = py + xScaled[j];
        dest[newIndex++] = src[oldIndex];
      }
    }
    return dest;
  }

  function PDFImage(xref, res, image, inline, smask, mask, isMask) {
    this.image = image;
    var dict = image.dict;
    if (dict.has('Filter')) {
      var filter = dict.get('Filter').name;
      if (filter === 'JPXDecode') {
        var jpxImage = new JpxImage();
        jpxImage.parseImageProperties(image.stream);
        image.stream.reset();
        image.bitsPerComponent = jpxImage.bitsPerComponent;
        image.numComps = jpxImage.componentsCount;
      } else if (filter === 'JBIG2Decode') {
        image.bitsPerComponent = 1;
        image.numComps = 1;
      }
    }
    // TODO cache rendered images?

    this.width = dict.get('Width', 'W');
    this.height = dict.get('Height', 'H');

    if (this.width < 1 || this.height < 1) {
      throw new FormatError(`Invalid image width: ${this.width} or ` +
                            `height: ${this.height}`);
    }

    this.interpolate = dict.get('Interpolate', 'I') || false;
    this.imageMask = dict.get('ImageMask', 'IM') || false;
    this.matte = dict.get('Matte') || false;

    var bitsPerComponent = image.bitsPerComponent;
    if (!bitsPerComponent) {
      bitsPerComponent = dict.get('BitsPerComponent', 'BPC');
      if (!bitsPerComponent) {
        if (this.imageMask) {
          bitsPerComponent = 1;
        } else {
          throw new FormatError(
            `Bits per component missing in image: ${this.imageMask}`);
        }
      }
    }
    this.bpc = bitsPerComponent;

    if (!this.imageMask) {
      var colorSpace = dict.get('ColorSpace', 'CS');
      if (!colorSpace) {
        info('JPX images (which do not require color spaces)');
        switch (image.numComps) {
          case 1:
            colorSpace = Name.get('DeviceGray');
            break;
          case 3:
            colorSpace = Name.get('DeviceRGB');
            break;
          case 4:
            colorSpace = Name.get('DeviceCMYK');
            break;
          default:
            throw new Error(`JPX images with ${this.numComps} ` +
                            'color components not supported.');
        }
      }
      this.colorSpace = ColorSpace.parse(colorSpace, xref, res);
      this.numComps = this.colorSpace.numComps;
    }

    this.decode = dict.getArray('Decode', 'D');
    this.needsDecode = false;
    if (this.decode &&
        ((this.colorSpace && !this.colorSpace.isDefaultDecode(this.decode)) ||
         (isMask && !ColorSpace.isDefaultDecode(this.decode, 1)))) {
      this.needsDecode = true;
      // Do some preprocessing to avoid more math.
      var max = (1 << bitsPerComponent) - 1;
      this.decodeCoefficients = [];
      this.decodeAddends = [];
      for (var i = 0, j = 0; i < this.decode.length; i += 2, ++j) {
        var dmin = this.decode[i];
        var dmax = this.decode[i + 1];
        this.decodeCoefficients[j] = dmax - dmin;
        this.decodeAddends[j] = max * dmin;
      }
    }

    if (smask) {
      this.smask = new PDFImage(xref, res, smask, false);
    } else if (mask) {
      if (isStream(mask)) {
        var maskDict = mask.dict, imageMask = maskDict.get('ImageMask', 'IM');
        if (!imageMask) {
          warn('Ignoring /Mask in image without /ImageMask.');
        } else {
          this.mask = new PDFImage(xref, res, mask, false, null, null, true);
        }
      } else {
        // Color key mask (just an array).
        this.mask = mask;
      }
    }
  }
  /**
   * Handles processing of image data and returns the Promise that is resolved
   * with a PDFImage when the image is ready to be used.
   */
  PDFImage.buildImage = function PDFImage_buildImage(handler, xref,
                                                     res, image, inline,
                                                     nativeDecoder) {
    var imagePromise = handleImageData(image, nativeDecoder);
    var smaskPromise;
    var maskPromise;

    var smask = image.dict.get('SMask');
    var mask = image.dict.get('Mask');

    if (smask) {
      smaskPromise = handleImageData(smask, nativeDecoder);
      maskPromise = Promise.resolve(null);
    } else {
      smaskPromise = Promise.resolve(null);
      if (mask) {
        if (isStream(mask)) {
          maskPromise = handleImageData(mask, nativeDecoder);
        } else if (isArray(mask)) {
          maskPromise = Promise.resolve(mask);
        } else {
          warn('Unsupported mask format.');
          maskPromise = Promise.resolve(null);
        }
      } else {
        maskPromise = Promise.resolve(null);
      }
    }
    return Promise.all([imagePromise, smaskPromise, maskPromise]).then(
      function(results) {
        var imageData = results[0];
        var smaskData = results[1];
        var maskData = results[2];
        return new PDFImage(xref, res, imageData, inline, smaskData, maskData);
      });
  };

  PDFImage.createMask =
      function PDFImage_createMask(imgArray, width, height,
                                   imageIsFromDecodeStream, inverseDecode) {

    // |imgArray| might not contain full data for every pixel of the mask, so
    // we need to distinguish between |computedLength| and |actualLength|.
    // In particular, if inverseDecode is true, then the array we return must
    // have a length of |computedLength|.

    var computedLength = ((width + 7) >> 3) * height;
    var actualLength = imgArray.byteLength;
    var haveFullData = computedLength === actualLength;
    var data, i;

    if (imageIsFromDecodeStream && (!inverseDecode || haveFullData)) {
      // imgArray came from a DecodeStream and its data is in an appropriate
      // form, so we can just transfer it.
      data = imgArray;
    } else if (!inverseDecode) {
      data = new Uint8Array(actualLength);
      data.set(imgArray);
    } else {
      data = new Uint8Array(computedLength);
      data.set(imgArray);
      for (i = actualLength; i < computedLength; i++) {
        data[i] = 0xff;
      }
    }

    // If necessary, invert the original mask data (but not any extra we might
    // have added above). It's safe to modify the array -- whether it's the
    // original or a copy, we're about to transfer it anyway, so nothing else
    // in this thread can be relying on its contents.
    if (inverseDecode) {
      for (i = 0; i < actualLength; i++) {
        data[i] = ~data[i];
      }
    }

    return { data, width, height, };
  };

  PDFImage.prototype = {
    get drawWidth() {
      return Math.max(this.width,
                      this.smask && this.smask.width || 0,
                      this.mask && this.mask.width || 0);
    },

    get drawHeight() {
      return Math.max(this.height,
                      this.smask && this.smask.height || 0,
                      this.mask && this.mask.height || 0);
    },

    decodeBuffer: function PDFImage_decodeBuffer(buffer) {
      var bpc = this.bpc;
      var numComps = this.numComps;

      var decodeAddends = this.decodeAddends;
      var decodeCoefficients = this.decodeCoefficients;
      var max = (1 << bpc) - 1;
      var i, ii;

      if (bpc === 1) {
        // If the buffer needed decode that means it just needs to be inverted.
        for (i = 0, ii = buffer.length; i < ii; i++) {
          buffer[i] = +!(buffer[i]);
        }
        return;
      }
      var index = 0;
      for (i = 0, ii = this.width * this.height; i < ii; i++) {
        for (var j = 0; j < numComps; j++) {
          buffer[index] = decodeAndClamp(buffer[index], decodeAddends[j],
                                         decodeCoefficients[j], max);
          index++;
        }
      }
    },

    getComponents: function PDFImage_getComponents(buffer) {
      var bpc = this.bpc;

      // This image doesn't require any extra work.
      if (bpc === 8) {
        return buffer;
      }

      var width = this.width;
      var height = this.height;
      var numComps = this.numComps;

      var length = width * height * numComps;
      var bufferPos = 0;
      var output = (bpc <= 8 ? new Uint8Array(length) :
        (bpc <= 16 ? new Uint16Array(length) : new Uint32Array(length)));
      var rowComps = width * numComps;

      var max = (1 << bpc) - 1;
      var i = 0, ii, buf;

      if (bpc === 1) {
        // Optimization for reading 1 bpc images.
        var mask, loop1End, loop2End;
        for (var j = 0; j < height; j++) {
          loop1End = i + (rowComps & ~7);
          loop2End = i + rowComps;

          // unroll loop for all full bytes
          while (i < loop1End) {
            buf = buffer[bufferPos++];
            output[i] = (buf >> 7) & 1;
            output[i + 1] = (buf >> 6) & 1;
            output[i + 2] = (buf >> 5) & 1;
            output[i + 3] = (buf >> 4) & 1;
            output[i + 4] = (buf >> 3) & 1;
            output[i + 5] = (buf >> 2) & 1;
            output[i + 6] = (buf >> 1) & 1;
            output[i + 7] = buf & 1;
            i += 8;
          }

          // handle remaining bits
          if (i < loop2End) {
            buf = buffer[bufferPos++];
            mask = 128;
            while (i < loop2End) {
              output[i++] = +!!(buf & mask);
              mask >>= 1;
            }
          }
        }
      } else {
        // The general case that handles all other bpc values.
        var bits = 0;
        buf = 0;
        for (i = 0, ii = length; i < ii; ++i) {
          if (i % rowComps === 0) {
            buf = 0;
            bits = 0;
          }

          while (bits < bpc) {
            buf = (buf << 8) | buffer[bufferPos++];
            bits += 8;
          }

          var remainingBits = bits - bpc;
          var value = buf >> remainingBits;
          output[i] = (value < 0 ? 0 : (value > max ? max : value));
          buf = buf & ((1 << remainingBits) - 1);
          bits = remainingBits;
        }
      }
      return output;
    },

    fillOpacity: function PDFImage_fillOpacity(rgbaBuf, width, height,
                                               actualHeight, image) {
      var smask = this.smask;
      var mask = this.mask;
      var alphaBuf, sw, sh, i, ii, j;

      if (smask) {
        sw = smask.width;
        sh = smask.height;
        alphaBuf = new Uint8Array(sw * sh);
        smask.fillGrayBuffer(alphaBuf);
        if (sw !== width || sh !== height) {
          alphaBuf = resizeImageMask(alphaBuf, smask.bpc, sw, sh,
                                     width, height);
        }
      } else if (mask) {
        if (mask instanceof PDFImage) {
          sw = mask.width;
          sh = mask.height;
          alphaBuf = new Uint8Array(sw * sh);
          mask.numComps = 1;
          mask.fillGrayBuffer(alphaBuf);

          // Need to invert values in rgbaBuf
          for (i = 0, ii = sw * sh; i < ii; ++i) {
            alphaBuf[i] = 255 - alphaBuf[i];
          }

          if (sw !== width || sh !== height) {
            alphaBuf = resizeImageMask(alphaBuf, mask.bpc, sw, sh,
                                       width, height);
          }
        } else if (isArray(mask)) {
          // Color key mask: if any of the components are outside the range
          // then they should be painted.
          alphaBuf = new Uint8Array(width * height);
          var numComps = this.numComps;
          for (i = 0, ii = width * height; i < ii; ++i) {
            var opacity = 0;
            var imageOffset = i * numComps;
            for (j = 0; j < numComps; ++j) {
              var color = image[imageOffset + j];
              var maskOffset = j * 2;
              if (color < mask[maskOffset] || color > mask[maskOffset + 1]) {
                opacity = 255;
                break;
              }
            }
            alphaBuf[i] = opacity;
          }
        } else {
          throw new FormatError('Unknown mask format.');
        }
      }

      if (alphaBuf) {
        for (i = 0, j = 3, ii = width * actualHeight; i < ii; ++i, j += 4) {
          rgbaBuf[j] = alphaBuf[i];
        }
      } else {
        // No mask.
        for (i = 0, j = 3, ii = width * actualHeight; i < ii; ++i, j += 4) {
          rgbaBuf[j] = 255;
        }
      }
    },

    undoPreblend: function PDFImage_undoPreblend(buffer, width, height) {
      var matte = this.smask && this.smask.matte;
      if (!matte) {
        return;
      }
      var matteRgb = this.colorSpace.getRgb(matte, 0);
      var matteR = matteRgb[0];
      var matteG = matteRgb[1];
      var matteB = matteRgb[2];
      var length = width * height * 4;
      var r, g, b;
      for (var i = 0; i < length; i += 4) {
        var alpha = buffer[i + 3];
        if (alpha === 0) {
          // according formula we have to get Infinity in all components
          // making it white (typical paper color) should be okay
          buffer[i] = 255;
          buffer[i + 1] = 255;
          buffer[i + 2] = 255;
          continue;
        }
        var k = 255 / alpha;
        r = (buffer[i] - matteR) * k + matteR;
        g = (buffer[i + 1] - matteG) * k + matteG;
        b = (buffer[i + 2] - matteB) * k + matteB;
        buffer[i] = r <= 0 ? 0 : r >= 255 ? 255 : r | 0;
        buffer[i + 1] = g <= 0 ? 0 : g >= 255 ? 255 : g | 0;
        buffer[i + 2] = b <= 0 ? 0 : b >= 255 ? 255 : b | 0;
      }
    },

    /**
     * Check whether resize image data or not
     * @param {Number} comps Number of color components, 1 or 3 is supported.
     * @param {Number} bpc Number of bits per component.
     * @return {Boolean}
     */
    shallResizeImage: function PDFImage_shallResizeImage(comps, bpc) {
      return (comps === 1 && (bpc === 1 || bpc === 8));
    },

    /**
     * Resize black white image data
     * @param {Uint8Array} imgData image data.
     * @param {Number} scaleBits
     * @author Ramsoft
     */
    resizeBWPixels: function PDFImage_resizeBWPixels(imgData, scaleBits) {
      var newWidth = imgData.width >> scaleBits;
      var newHeight = imgData.height >> scaleBits;

      //we want to output 1 byte per pixel
      var newRowBytes = (newWidth + 7) >> 3;
      var originalRowBytes = (imgData.width + 7) >> 3;
      var step = 1 << scaleBits;
      var numBytes = newHeight * newRowBytes;
      var pixelArrayOutput = new Uint8Array(numBytes);

      for (var i = 0, y2 = 0; i < newHeight; i++, y2 += step) {
        var originalRowStart = y2 * originalRowBytes;
        var newRowStart = i * newRowBytes;

        for (var j = 0, x2 = 0; j < newWidth; j++, x2 += step) {
          // we want original value of pixel [x2, y2] value in original image
          // to populate pixel [i, j] in new image

          var originalColByteStart = x2 >> 3;
          var originalColBitMask = 1 << (7 - (x2 & 7));
          // most signifcant bit is first pixel due to Little Endian

          var originalColByte =
            imgData.data[originalRowStart + originalColByteStart];
          var pixelValue = originalColByte & originalColBitMask;

          if (pixelValue > 0) {
            // most signifcant bit is first pixel due to Little Endian
            var newColByteStart = j >> 3;
            var newColBitMask = 1 << (7 - (j & 7));

            var newColByte = pixelArrayOutput[newRowStart + newColByteStart];

            newColByte = newColByte | newColBitMask;
            // set pixel bit to 1
            pixelArrayOutput[newRowStart + newColByteStart] = newColByte;
          }
        }
      }

      imgData.data = pixelArrayOutput;
      imgData.width = newWidth;
      imgData.height = newHeight;
    },

    /**
     * Resize large resolution PDFS as to improve rendering time
     * @param  {Uint8Array} imgData image data.
     * @param  {Number} comps Number of color components.
     * @param  {Number} bpc Number of bits per component.
     */
    resizeGrayPixels: function PDFImage_resizeGrayPixels(imgData, comps, bpc) {
      var scaleBits;
      var h1 = imgData.height;
      var w1 = imgData.width;

      // Reduce the pixel dimensions to around 2000.
      // to improve performance for large grayscale bitmaps > 10K width 
      // or height
      // If Width or Height > 15K, scale down the size to 10% of original size.
      // If Width or Height > 10K, scale down the size to 15% of original size.
      // If Width or Height > 5K, scale down the size to 25% of original size.
      // Otherwise, use the original size.
      if ((h1 > 15000) || (w1 > 15000)) {
        scaleBits = 3;
      } else if ((h1 > 10000) || (w1 > 10000)) {
        scaleBits = 2;
      } else if ((h1 > 5000) || (w1 > 5000)) {
        scaleBits = 1; // 25% - 4
      } else {
        scaleBits = 0;
      }

      if (scaleBits > 0) {
        if (bpc === 1) {
          this.resizeBWPixels(imgData, scaleBits);
        } else {
          var w2 = w1 >> scaleBits;
          var h2 = h1 >> scaleBits;
          // we want to output 1 byte per pixel
          var newRowBytes = (w2 * comps * bpc + 7) >> 3;
          var originalRowBytes = (w1 * comps * bpc + 7) >> 3;
          var step = 1 << scaleBits;
          var numBytes = h2 * newRowBytes;
          var pixelArrayOutput = new Uint8Array(numBytes);

          for (var i = 0, y2 = 0; i < h2; i++, y2 += step) {
            var newRowStart = i * newRowBytes;
            var originalRowStart = y2 * originalRowBytes;

            for (var j = 0, x2 = 0; j < w2; j++, x2 += step) {
              pixelArrayOutput[newRowStart + j] =
                imgData.data[originalRowStart + x2];
            }
          }

          imgData.data = pixelArrayOutput;
          imgData.width = w2;
          imgData.height = h2;
        }
      }

      return imgData;
    },

    createImageData: function PDFImage_createImageData(forceRGBA) {
      var drawWidth = this.drawWidth;
      var drawHeight = this.drawHeight;
      var imgData = { // other fields are filled in below
        width: drawWidth,
        height: drawHeight,
      };

      var numComps = this.numComps;
      var originalWidth = this.width;
      var originalHeight = this.height;
      var bpc = this.bpc;

      // Rows start at byte boundary.
      var rowBytes = (originalWidth * numComps * bpc + 7) >> 3;
      var imgArray;

      if (!forceRGBA) {
        // If it is a 1-bit-per-pixel grayscale (i.e. black-and-white) image
        // without any complications, we pass a same-sized copy to the main
        // thread rather than expanding by 32x to RGBA form. This saves *lots*
        // of memory for many scanned documents. It's also much faster.
        //
        // Similarly, if it is a 24-bit-per pixel RGB image without any
        // complications, we avoid expanding by 1.333x to RGBA form.
        var kind;
        if (this.colorSpace.name === 'DeviceGray' && bpc === 1) {
          kind = ImageKind.GRAYSCALE_1BPP;
        } else if (this.colorSpace.name === 'DeviceRGB' && bpc === 8 &&
                   !this.needsDecode) {
          kind = ImageKind.RGB_24BPP;
        }
        if (kind && !this.smask && !this.mask &&
            drawWidth === originalWidth && drawHeight === originalHeight) {
          imgData.kind = kind;

          imgArray = this.getImageBytes(originalHeight * rowBytes);
          // If imgArray came from a DecodeStream, we're safe to transfer it
          // (and thus detach its underlying buffer) because it will constitute
          // the entire DecodeStream's data.  But if it came from a Stream, we
          // need to copy it because it'll only be a portion of the Stream's
          // data, and the rest will be read later on.
          if (this.image instanceof DecodeStream) {
            imgData.data = imgArray;
          } else {
            var newArray = new Uint8Array(imgArray.length);
            newArray.set(imgArray);
            imgData.data = newArray;
          }
          if (this.needsDecode) {
            // Invert the buffer (which must be grayscale if we reached here).
            assert(kind === ImageKind.GRAYSCALE_1BPP);
            var buffer = imgData.data;
            for (var i = 0, ii = buffer.length; i < ii; i++) {
              buffer[i] ^= 0xff;
            }
          }
          // Not resize data when rendering on web
          if (!this.print) {
            if (kind === ImageKind.GRAYSCALE_1BPP &&
                this.shallResizeImage(numComps, bpc)) {
              this.resizeGrayPixels(imgData, numComps, bpc);
            }
          }
          return imgData;
        }
        if (this.image instanceof JpegStream && !this.smask && !this.mask &&
            (this.colorSpace.name === 'DeviceGray' ||
             this.colorSpace.name === 'DeviceRGB' ||
             this.colorSpace.name === 'DeviceCMYK')) {
          imgData.kind = ImageKind.RGB_24BPP;
          imgData.data = this.getImageBytes(originalHeight * rowBytes,
                                            drawWidth, drawHeight, true);
          return imgData;
        }
      }

      imgArray = this.getImageBytes(originalHeight * rowBytes);

      if (this.colorSpace.name === 'DeviceGray') {
        var resizedImgData = {
          data: imgArray,
          width: originalWidth,
          height: originalHeight
        };

        if (!this.print) {
          if (this.shallResizeImage(numComps, bpc)) {
            this.resizeGrayPixels(resizedImgData, numComps, bpc);
            imgArray = resizedImgData.data;
            originalHeight = resizedImgData.height;
            originalWidth = resizedImgData.width;
            rowBytes = (originalWidth * numComps * bpc + 7) >> 3;
          }
        }
      }
      // imgArray can be incomplete (e.g. after CCITT fax encoding).
      var actualHeight = 0 | (imgArray.length / rowBytes *
                         drawHeight / originalHeight);

      var comps = this.getComponents(imgArray);

      // If opacity data is present, use RGBA_32BPP form. Otherwise, use the
      // more compact RGB_24BPP form if allowable.
      var alpha01, maybeUndoPreblend;
      if (!forceRGBA && !this.smask && !this.mask) {
        imgData.kind = ImageKind.RGB_24BPP;
        imgData.data = new Uint8Array(drawWidth * drawHeight * 3);
        alpha01 = 0;
        maybeUndoPreblend = false;
      } else {
        imgData.kind = ImageKind.RGBA_32BPP;
        imgData.data = new Uint8Array(drawWidth * drawHeight * 4);
        alpha01 = 1;
        maybeUndoPreblend = true;

        // Color key masking (opacity) must be performed before decoding.
        this.fillOpacity(imgData.data, drawWidth, drawHeight, actualHeight,
                         comps);
      }

      if (this.needsDecode) {
        this.decodeBuffer(comps);
      }
      this.colorSpace.fillRgb(imgData.data, originalWidth, originalHeight,
                              drawWidth, drawHeight, actualHeight, bpc, comps,
                              alpha01);
      if (maybeUndoPreblend) {
        this.undoPreblend(imgData.data, drawWidth, actualHeight);
      }

      return imgData;
    },

    fillGrayBuffer: function PDFImage_fillGrayBuffer(buffer) {
      var numComps = this.numComps;
      if (numComps !== 1) {
        throw new FormatError(
          `Reading gray scale from a color image: ${numComps}`);
      }

      var width = this.width;
      var height = this.height;
      var bpc = this.bpc;

      // rows start at byte boundary
      var rowBytes = (width * numComps * bpc + 7) >> 3;
      var imgArray = this.getImageBytes(height * rowBytes);

      var comps = this.getComponents(imgArray);
      var i, length;

      if (bpc === 1) {
        // inline decoding (= inversion) for 1 bpc images
        length = width * height;
        if (this.needsDecode) {
          // invert and scale to {0, 255}
          for (i = 0; i < length; ++i) {
            buffer[i] = (comps[i] - 1) & 255;
          }
        } else {
          // scale to {0, 255}
          for (i = 0; i < length; ++i) {
            buffer[i] = (-comps[i]) & 255;
          }
        }
        return;
      }

      if (this.needsDecode) {
        this.decodeBuffer(comps);
      }
      length = width * height;
      // we aren't using a colorspace so we need to scale the value
      var scale = 255 / ((1 << bpc) - 1);
      for (i = 0; i < length; ++i) {
        buffer[i] = (scale * comps[i]) | 0;
      }
    },

    getImageBytes: function PDFImage_getImageBytes(length,
                                                   drawWidth, drawHeight,
                                                   forceRGB) {
      this.image.reset();
      this.image.drawWidth = drawWidth || this.width;
      this.image.drawHeight = drawHeight || this.height;
      this.image.forceRGB = !!forceRGB;
      return this.image.getBytes(length);
    },
  };
  return PDFImage;
})();

export {
  PDFImage,
};
