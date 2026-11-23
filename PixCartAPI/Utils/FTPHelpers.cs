using FluentFTP;
using Utils.Interface;

namespace Utils;

public class FTPHelpers(AppSettings settings) : IFTPHelpers
{
    private AsyncFtpClient Client() =>
        new(settings.FtpHost, settings.FtpUser, settings.FtpPassword, settings.FtpPort,
            new FtpConfig { EncryptionMode = FtpEncryptionMode.Auto, ValidateAnyCertificate = false, ConnectTimeout = 15000 });

    private string Full(string remotePath) => $"{settings.FtpBaseDir.TrimEnd('/')}/{remotePath.TrimStart('/')}";

    public async Task UploadAsync(string remotePath, byte[] content, CancellationToken ct = default)
    {
        await using var c = Client();
        await c.AutoConnect(ct);
        var status = await c.UploadBytes(content, Full(remotePath), FtpRemoteExists.Overwrite, createRemoteDir: true, token: ct);
        if (status == FtpStatus.Failed) throw new AppException("Could not save the file", "storage_failed", 502);
    }

    public async Task<byte[]> DownloadAsync(string remotePath, CancellationToken ct = default)
    {
        await using var c = Client();
        await c.AutoConnect(ct);
        var bytes = await c.DownloadBytes(Full(remotePath), ct);
        return bytes ?? throw new NotFoundException("File");
    }

    public async Task DeleteAsync(string remotePath, CancellationToken ct = default)
    {
        await using var c = Client();
        await c.AutoConnect(ct);
        if (await c.FileExists(Full(remotePath), ct)) await c.DeleteFile(Full(remotePath), ct);
    }
}
