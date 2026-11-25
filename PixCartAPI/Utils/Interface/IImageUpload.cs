namespace Utils.Interface;

/// <summary>
/// Public images and videos (products, reviews, banners) and private documents (seller KYC). Images are decoded and
/// re-encoded to WebP (at most 1600 px a side), which strips EXIF/GPS and anything that is not pixels. Files are stored
/// on disk or on the FTP server (AppSettings.StorageBackend).
/// </summary>
public interface IImageUpload
{
    /// <summary>Saves an image; returns its public URL ("/media/products/ab12….webp").</summary>
    Task<string> SaveImageAsync(byte[] data, string folder, CancellationToken ct = default);

    /// <summary>Saves an MP4 or WebM video (checked by its first bytes); returns its public URL.</summary>
    Task<string> SaveVideoAsync(byte[] data, long maxBytes, string folder = "videos", CancellationToken ct = default);

    /// <summary>Saves a file under a fixed public name (app packages: /media/apps/pixcart-shop.apk).</summary>
    Task<string> SavePublicFileAsync(byte[] data, string relativePath, CancellationToken ct = default);

    /// <summary>Stores the partner Android app publicly (checked ZIP with a manifest and compiled code);
    /// returns its public URL (reference: storage.save_app_package).</summary>
    Task<string> SaveAppPackageAsync(byte[] data, long maxBytes, string name, CancellationToken ct = default);

    /// <summary>Saves a PDF/JPEG/PNG document privately; returns (key, content type). Never served publicly.</summary>
    Task<(string Key, string ContentType)> SavePrivateAsync(byte[] data, string folder, CancellationToken ct = default);

    Task<byte[]> ReadPrivateAsync(string key, CancellationToken ct = default);
}
