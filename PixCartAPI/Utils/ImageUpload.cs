using SkiaSharp;
using Utils.Interface;

namespace Utils;

public class ImageUpload(AppSettings settings, IFTPHelpers ftp) : IImageUpload
{
    private const int MaxSide = 1600;
    private const int MinSide = 200;
    private const long MaxPixels = 40_000_000;

    private static readonly (byte[] Magic, string Type, string Ext)[] DocTypes =
    [
        ("%PDF-"u8.ToArray(), "application/pdf", "pdf"),
        ([0xFF, 0xD8, 0xFF], "image/jpeg", "jpg"),
        ([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "image/png", "png"),
    ];

    public async Task<string> SaveImageAsync(byte[] data, string folder, CancellationToken ct = default)
    {
        if (data.Length > settings.MaxImageBytes)
            throw new AppException($"Image must be smaller than {settings.MaxImageBytes / (1024 * 1024)} MB", "file_too_large");
        var webp = await Task.Run(() => ProcessImage(data), ct);
        var key = $"{folder}/{Guid.NewGuid():N}.webp";
        await WritePublic(key, webp, ct);
        return $"{settings.MediaBaseUrl.TrimEnd('/')}/{key}";
    }

    /// <summary>Decode, apply the camera orientation, flatten transparency on white, shrink to 1600 px, encode WebP 85.</summary>
    public static byte[] ProcessImage(byte[] data)
    {
        using var codec = SKCodec.Create(new MemoryStream(data)) ?? throw new AppException("This file is not a valid image", "invalid_image");
        var info = codec.Info;
        if ((long)info.Width * info.Height > MaxPixels) throw new AppException("This file is not a valid image", "invalid_image");
        using var decoded = SKBitmap.Decode(codec) ?? throw new AppException("This file is not a valid image", "invalid_image");
        using var oriented = Orient(decoded, codec.EncodedOrigin);
        if (oriented.Width < MinSide || oriented.Height < MinSide)
            throw new AppException("Image must be at least 200 x 200 pixels", "image_too_small");
        var scale = Math.Min(1.0, (double)MaxSide / Math.Max(oriented.Width, oriented.Height));
        var w = Math.Max(1, (int)Math.Round(oriented.Width * scale));
        var h = Math.Max(1, (int)Math.Round(oriented.Height * scale));
        using var surface = SKSurface.Create(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Premul));
        surface.Canvas.Clear(SKColors.White);
        using var img = SKImage.FromBitmap(oriented);
        surface.Canvas.DrawImage(img, new SKRect(0, 0, w, h), new SKSamplingOptions(SKCubicResampler.Mitchell));
        using var snap = surface.Snapshot();
        using var encoded = snap.Encode(SKEncodedImageFormat.Webp, 85);
        return encoded.ToArray();
    }

    private static SKBitmap Orient(SKBitmap src, SKEncodedOrigin origin)
    {
        if (origin == SKEncodedOrigin.TopLeft) return src.Copy();
        var swap = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
        var dst = new SKBitmap(swap ? src.Height : src.Width, swap ? src.Width : src.Height);
        using var c = new SKCanvas(dst);
        switch (origin)
        {
            case SKEncodedOrigin.TopRight: c.Scale(-1, 1, src.Width / 2f, 0); break;
            case SKEncodedOrigin.BottomRight: c.RotateDegrees(180, src.Width / 2f, src.Height / 2f); break;
            case SKEncodedOrigin.BottomLeft: c.Scale(1, -1, 0, src.Height / 2f); break;
            case SKEncodedOrigin.LeftTop: c.Translate(dst.Width, 0); c.RotateDegrees(90); c.Scale(1, -1, 0, src.Height / 2f); break;
            case SKEncodedOrigin.RightTop: c.Translate(dst.Width, 0); c.RotateDegrees(90); break;
            case SKEncodedOrigin.RightBottom: c.Translate(dst.Width, 0); c.RotateDegrees(90); c.Scale(-1, -1, src.Width / 2f, src.Height / 2f); break;
            case SKEncodedOrigin.LeftBottom: c.Translate(0, dst.Height); c.RotateDegrees(270); break;
        }
        using (var image = SKImage.FromBitmap(src)) c.DrawImage(image, 0, 0, new SKSamplingOptions(SKFilterMode.Linear));
        return dst;
    }

    public async Task<string> SaveVideoAsync(byte[] data, long maxBytes, string folder = "videos", CancellationToken ct = default)
    {
        if (data.Length > maxBytes) throw new AppException($"Video must be smaller than {maxBytes / (1024 * 1024)} MB", "file_too_large");
        var (_, ext) = SniffVideo(data);
        var key = $"{folder}/{Guid.NewGuid():N}.{ext}";
        await WritePublic(key, data, ct);
        return $"{settings.MediaBaseUrl.TrimEnd('/')}/{key}";
    }

    /// <summary>MP4 (ftyp box that is not a still-picture brand like HEIC/AVIF) or WebM (EBML header).</summary>
    public static (string ContentType, string Ext) SniffVideo(byte[] data)
    {
        if (data.Length >= 4 && data[0] == 0x1A && data[1] == 0x45 && data[2] == 0xDF && data[3] == 0xA3) return ("video/webm", "webm");
        if (data.Length >= 12 && data[4] == 'f' && data[5] == 't' && data[6] == 'y' && data[7] == 'p')
        {
            var brand = System.Text.Encoding.ASCII.GetString(data, 8, 4);
            string[] still = ["avif", "avis", "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"];
            if (!still.Contains(brand)) return ("video/mp4", "mp4");
        }
        throw new AppException("Upload an MP4 or WebM video", "invalid_video");
    }

    public async Task<string> SavePublicFileAsync(byte[] data, string relativePath, CancellationToken ct = default)
    {
        await WritePublic(relativePath.TrimStart('/'), data, ct);
        return $"{settings.MediaBaseUrl.TrimEnd('/')}/{relativePath.TrimStart('/')}";
    }

    public async Task<(string Key, string ContentType)> SavePrivateAsync(byte[] data, string folder, CancellationToken ct = default)
    {
        if (data.Length > settings.MaxDocumentBytes)
            throw new AppException($"File must be smaller than {settings.MaxDocumentBytes / (1024 * 1024)} MB", "file_too_large");
        var match = DocTypes.FirstOrDefault(d => data.AsSpan().StartsWith(d.Magic));
        if (match.Type is null) throw new AppException("Upload a PDF, JPG or PNG file", "invalid_document");
        var key = $"{folder}/{Guid.NewGuid():N}.{match.Ext}";
        if (settings.StorageBackend == "ftp") await ftp.UploadAsync($"private/{key}", data, ct);
        else
        {
            var path = Path.Combine(settings.PrivateRoot, key);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllBytesAsync(path, data, ct);
        }
        return (key, match.Type);
    }

    public async Task<byte[]> ReadPrivateAsync(string key, CancellationToken ct = default)
    {
        if (key.Contains("..")) throw new NotFoundException("File");
        if (settings.StorageBackend == "ftp") return await ftp.DownloadAsync($"private/{key}", ct);
        var path = Path.Combine(settings.PrivateRoot, key);
        if (!File.Exists(path)) throw new NotFoundException("File");
        return await File.ReadAllBytesAsync(path, ct);
    }

    private async Task WritePublic(string key, byte[] data, CancellationToken ct)
    {
        if (settings.StorageBackend == "ftp")
        {
            await ftp.UploadAsync($"media/{key}", data, ct);
            return;
        }
        var path = Path.Combine(settings.MediaRoot, key);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, data, ct);
    }
}
