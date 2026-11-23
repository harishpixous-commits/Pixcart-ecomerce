namespace Utils.Interface;

/// <summary>Files on the company FTP server (used when AppSettings.StorageBackend is "ftp").</summary>
public interface IFTPHelpers
{
    Task UploadAsync(string remotePath, byte[] content, CancellationToken ct = default);
    Task<byte[]> DownloadAsync(string remotePath, CancellationToken ct = default);
    Task DeleteAsync(string remotePath, CancellationToken ct = default);
}
