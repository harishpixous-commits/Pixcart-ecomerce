using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Model.CustomeAttributes;

// Validation attributes whose messages are the reference API's plain words ("needs at least 2 characters",
// "is not a valid email address", "must be one of: 'home', 'work' or 'other'"), so the 422 answers read the same.

/// <summary>The field must be present (null fails; an empty string is left to <see cref="LenAttribute"/>).</summary>
public sealed class PresentAttribute : RequiredAttribute
{
    public PresentAttribute()
    {
        AllowEmptyStrings = true;
        ErrorMessage = "is required";
    }
}

/// <summary>Text length limits (min and/or max), or item count limits for a list.</summary>
public sealed class LenAttribute(int min = 0, int max = int.MaxValue) : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        string? msg = null;
        if (value is string s)
        {
            if (s.Length < min) msg = min == 1 ? "is required" : $"needs at least {min} characters";
            else if (s.Length > max) msg = $"can be at most {max} characters";
        }
        else if (value is System.Collections.ICollection c)
        {
            if (c.Count < min) msg = $"needs at least {min}";
            else if (c.Count > max) msg = $"can have at most {max}";
        }
        return msg is null ? ValidationResult.Success : new ValidationResult(msg, context.MemberName is { } m ? [m] : null);
    }
}

/// <summary>An email address (like Pydantic's EmailStr: one @, a dotted domain, no spaces).</summary>
public sealed partial class EmailAttribute : ValidationAttribute
{
    [GeneratedRegex(@"^[^@\s<>()\[\],;:""]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$")]
    private static partial Regex Pattern();

    public static bool IsEmail(string? v) => v is not null && v.Length <= 254 && Pattern().IsMatch(v) && !v.Split('@')[0].StartsWith('.')
                                             && !v.Split('@')[0].EndsWith('.') && !v.Contains("..");

    protected override ValidationResult? IsValid(object? value, ValidationContext context) =>
        value is null || IsEmail(value as string)
            ? ValidationResult.Success
            : new ValidationResult("is not a valid email address", context.MemberName is { } m ? [m] : null);
}

/// <summary>One of the listed values (Pydantic's Literal).</summary>
public sealed class OneOfAttribute(params string[] choices) : ValidationAttribute
{
    public string[] Choices { get; } = choices;

    public static string Expected(string[] choices) =>
        choices.Length == 1 ? $"'{choices[0]}'" : string.Join(", ", choices[..^1].Select(c => $"'{c}'")) + $" or '{choices[^1]}'";

    protected override ValidationResult? IsValid(object? value, ValidationContext context) =>
        value is null || (value is string s && Choices.Contains(s))
            ? ValidationResult.Success
            : new ValidationResult($"must be one of: {Expected(Choices)}", context.MemberName is { } m ? [m] : null);
}

/// <summary>A number within limits (Pydantic's ge/le), with the limits written as the reference shows them.</summary>
public sealed class BetweenAttribute(double min, double max) : ValidationAttribute
{
    /// <summary>Write the limits like Python floats ("6.0") instead of integers ("6").</summary>
    public bool AsFloat { get; set; }

    private string Show(double v) => AsFloat && v == Math.Floor(v) ? v.ToString("0.0", CultureInfo.InvariantCulture) : v.ToString(CultureInfo.InvariantCulture);

    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is null) return ValidationResult.Success;
        var d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        string? msg = d < min ? $"must be at least {Show(min)}" : d > max ? $"must be at most {Show(max)}" : null;
        return msg is null ? ValidationResult.Success : new ValidationResult(msg, context.MemberName is { } m ? [m] : null);
    }
}
