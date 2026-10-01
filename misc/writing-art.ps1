# Makes the writing art in skymp5-front/src/img from the owner's Graphics\writing set: paper as JPEG plus an alpha mask, illuminated capitals and house seals as small PNGs
# powershell -File misc/writing-art.ps1 [-Src C:\Users\Administrator\Desktop\Graphics\writing]
param(
  [string]$Src = 'C:\Users\Administrator\Desktop\Graphics\writing',
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;

public static class WritingArt {
  static Bitmap Scaled(Bitmap src, Rectangle from, int longSide) {
    double k = Math.Min(1.0, (double)longSide / Math.Max(from.Width, from.Height));
    int w = Math.Max(1, (int)Math.Round(from.Width * k)), h = Math.Max(1, (int)Math.Round(from.Height * k));
    var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(dst))
    using (var attrs = new ImageAttributes()) {
      g.CompositingMode = CompositingMode.SourceCopy;
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      attrs.SetWrapMode(WrapMode.TileFlipXY);
      g.DrawImage(src, new Rectangle(0, 0, w, h), from.X, from.Y, from.Width, from.Height, GraphicsUnit.Pixel, attrs);
    }
    return dst;
  }

  static Bitmap Load(string path) {
    using (var raw = new Bitmap(path)) return raw.Clone(new Rectangle(0, 0, raw.Width, raw.Height), PixelFormat.Format32bppArgb);
  }

  static byte[] Pixels(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * b.Height];
    Marshal.Copy(d.Scan0, px, 0, px.Length);
    b.UnlockBits(d);
    return px;
  }

  static Bitmap FromPixels(int w, int h, byte[] px) {
    var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(px, 0, d.Scan0, px.Length);
    b.UnlockBits(d);
    return b;
  }

  static void SaveJpeg(Bitmap b, string path, long quality) {
    var codec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
    using (var p = new EncoderParameters(1)) {
      p.Param[0] = new EncoderParameter(Encoder.Quality, quality);
      b.Save(path, codec, p);
    }
  }

  static Rectangle Opaque(Bitmap b) {
    var px = Pixels(b);
    int minX = b.Width, minY = b.Height, maxX = -1, maxY = -1;
    for (int y = 0; y < b.Height; y++) for (int x = 0; x < b.Width; x++) {
      if (px[(y * b.Width + x) * 4 + 3] < 8) continue;
      minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y);
    }
    return maxX < 0 ? new Rectangle(0, 0, b.Width, b.Height) : Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
  }

  // Colour over the mean opaque colour, so soft mask edges blend into the paper; the mask keeps only the alpha
  public static string Paper(string src, string jpg, string mask, int longSide, long quality, bool crop) {
    using (var raw = Load(src))
    using (var b = Scaled(raw, crop ? Opaque(raw) : new Rectangle(0, 0, raw.Width, raw.Height), longSide)) {
      var px = Pixels(b);
      double r = 0, g = 0, bl = 0, n = 0;
      for (int i = 0; i < px.Length; i += 4) if (px[i + 3] > 250) { bl += px[i]; g += px[i + 1]; r += px[i + 2]; n++; }
      if (n == 0) n = 1;
      var flat = new byte[px.Length];
      var alpha = new byte[px.Length];
      for (int i = 0; i < px.Length; i += 4) {
        double a = px[i + 3] / 255.0;
        flat[i] = (byte)Math.Round(px[i] * a + bl / n * (1 - a));
        flat[i + 1] = (byte)Math.Round(px[i + 1] * a + g / n * (1 - a));
        flat[i + 2] = (byte)Math.Round(px[i + 2] * a + r / n * (1 - a));
        flat[i + 3] = 255;
        alpha[i + 3] = px[i + 3];
      }
      using (var f = FromPixels(b.Width, b.Height, flat)) SaveJpeg(f, jpg, quality);
      using (var m = FromPixels(b.Width, b.Height, alpha)) m.Save(mask, ImageFormat.Png);
      return b.Width + "x" + b.Height;
    }
  }

  public static string Png(string src, string dst, int longSide) {
    using (var raw = Load(src))
    using (var b = Scaled(raw, new Rectangle(0, 0, raw.Width, raw.Height), longSide)) {
      b.Save(dst, ImageFormat.Png);
      return b.Width + "x" + b.Height;
    }
  }

  // Black ink on white becomes the given ink on transparency, cropped to the drawing
  public static string Stamp(string src, string dst, int longSide, int ink) {
    using (var raw = Load(src)) {
      var px = Pixels(raw);
      int minX = raw.Width, minY = raw.Height, maxX = -1, maxY = -1;
      for (int y = 0; y < raw.Height; y++) for (int x = 0; x < raw.Width; x++) {
        int i = (y * raw.Width + x) * 4;
        int lum = (px[i] * 114 + px[i + 1] * 587 + px[i + 2] * 299) / 1000;
        byte a = (byte)((255 - lum) * px[i + 3] / 255);
        px[i] = (byte)(ink & 255);
        px[i + 1] = (byte)((ink >> 8) & 255);
        px[i + 2] = (byte)((ink >> 16) & 255);
        px[i + 3] = a;
        if (a > 24) { minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y); }
      }
      if (maxX < 0) throw new Exception(src + ": no ink found");
      using (var inked = FromPixels(raw.Width, raw.Height, px))
      using (var b = Scaled(inked, Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1), longSide)) {
        b.Save(dst, ImageFormat.Png);
        return b.Width + "x" + b.Height;
      }
    }
  }
}
'@

$img = Join-Path $Repo 'skymp5-front\src\img'
$writing = Join-Path $img 'writing'
$fancy = Join-Path $writing 'fancy'
$seals = Join-Path $img 'seals'
New-Item -ItemType Directory -Force $fancy | Out-Null

function Report($name, $out, $size) {
  '{0} -> {1} {2} {3} bytes' -f $name, (Split-Path $out -Leaf), $size, (Get-Item $out).Length
}

# Paper art: note, the sealed face cut to the letter, and the two-page journal spread
foreach ($p in @(@('note.png', 'note', 844, $false), @('Note_sealed.png', 'sealed', 340, $true), @('journal.png', 'journal', 941, $false))) {
  $jpg = Join-Path $writing ($p[1] + '.jpg')
  $mask = Join-Path $writing ($p[1] + '-mask.png')
  $size = [WritingArt]::Paper((Join-Path $Src $p[0]), $jpg, $mask, $p[2], 82, $p[3])
  Report $p[0] $jpg $size
  Report $p[0] $mask $size
}

# Illuminated capitals, one <LETTER>.png each
Get-ChildItem (Join-Path $Src 'fancy') -Filter '*.png' | ForEach-Object {
  if ($_.Name -notmatch '([A-Z])_letter\.png$') { return }
  $out = Join-Path $fancy ($Matches[1] + '.png')
  Report $_.Name $out ([WritingArt]::Png($_.FullName, $out, 128))
}

# House marks for the seal table, by the slug of the faction id they belong to
$out = Join-Path $seals 'house-telvanni.png'
Report 'telvanni seal.png' $out ([WritingArt]::Stamp((Join-Path $Src 'telvanni seal.png'), $out, 256, 0x3d2352))
foreach ($p in @(
    @('SR-banner-House_Telvanni.png', 'house-telvanni-banner'),
    @('ON-banner-House_Dres.png', 'house-dres'),
    @('ON-banner-House_Indoril.png', 'house-indoril'),
    @('SR-banner-House_Redoran.png', 'house-redoran'),
    @('sadras.png', 'house-sadras'),
    @('MW-book-Morag_Tong.png', 'morag-tong'))) {
  $out = Join-Path $seals ($p[1] + '.png')
  Report $p[0] $out ([WritingArt]::Png((Join-Path $Src $p[0]), $out, 256))
}
