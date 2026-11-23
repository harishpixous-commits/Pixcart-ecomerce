using Microsoft.AspNetCore.Mvc;
using Utils.Interface;

namespace API.Controllers;

/// <summary>Liveness and readiness for the hosting (IIS health checks, uptime monitors).</summary>
[ApiController]
public class HealthController(IMySqlDapperHelper db) : ControllerBase
{
    [HttpGet("/api/health")]
    public async Task<object> Health()
    {
        await db.ExecuteScalarAsync<int>("SELECT 1");
        return new { ok = true };
    }
}
