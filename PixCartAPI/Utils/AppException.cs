namespace Utils;

/// <summary>
/// An expected failure with a stable machine code and a message for people. The API turns it into
/// <c>{"error": {"code", "message", "fields"}}</c> with the status code (the same shape as the reference API).
/// </summary>
public class AppException : Exception
{
    public int StatusCode { get; }
    public string Code { get; }
    public IDictionary<string, string> Fields { get; }

    public AppException(string message, string code = "bad_request", int statusCode = 400, IDictionary<string, string>? fields = null)
        : base(message)
    {
        Code = code;
        StatusCode = statusCode;
        Fields = fields ?? new Dictionary<string, string>();
    }
}

public sealed class NotFoundException(string what = "Resource") : AppException($"{what} not found", "not_found", 404);

public sealed class ForbiddenException(string message = "You do not have access to this resource") : AppException(message, "forbidden", 403);

public sealed class UnauthorizedException(string message = "Please sign in") : AppException(message, "unauthorized", 401);

public sealed class ConflictException(string message, string code = "conflict") : AppException(message, code, 409);

public sealed class TooManyRequestsException(string message = "Too many attempts. Please try again later.") : AppException(message, "rate_limited", 429);
