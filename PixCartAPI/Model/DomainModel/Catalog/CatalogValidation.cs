using System.Collections;
using System.ComponentModel.DataAnnotations;
using System.Globalization;

namespace Model.DomainModel.Catalog;

// Validation attributes whose messages read like the reference API's friendly validation messages
// ("needs at least 10 characters", "must be at most 5", "must be one of: 'question' or 'answer'").

/// <summary>Text length (null is left to [Required]).</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class LenAttribute(int min, int max) : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is not string s) return ValidationResult.Success;
        if (s.Length < min) return new ValidationResult(min == 1 ? "is required" : $"needs at least {min} characters");
        if (s.Length > max) return new ValidationResult($"can be at most {max} characters");
        return ValidationResult.Success;
    }
}

/// <summary>Number of items in a list.</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class CountAttribute(int max) : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context) =>
        value is ICollection c && c.Count > max ? new ValidationResult($"can have at most {max}") : ValidationResult.Success;
}

/// <summary>A whole or decimal number in a range (inclusive).</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class BetweenAttribute(double lo, double hi) : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is null) return ValidationResult.Success;
        var d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (d < lo) return new ValidationResult($"must be at least {Fmt(lo)}");
        if (d > hi) return new ValidationResult($"must be at most {Fmt(hi)}");
        return ValidationResult.Success;
    }

    private static string Fmt(double v) => v.ToString(CultureInfo.InvariantCulture);
}

/// <summary>One of a fixed set of words (the reference API's Literal[...]).</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class OneOfAttribute(params string[] choices) : ValidationAttribute
{
    public string[] Choices { get; } = choices;

    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is null || (value is string s && Choices.Contains(s))) return ValidationResult.Success;
        var quoted = Choices.Select(c => $"'{c}'").ToList();
        var expected = quoted.Count == 1 ? quoted[0] : string.Join(", ", quoted.Take(quoted.Count - 1)) + " or " + quoted[^1];
        return new ValidationResult($"must be one of: {expected}");
    }
}

/// <summary>A text matching a regular expression, with a plain-words hint.</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class PatternAttribute(string pattern, string hint = "is not in the right format") : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context) =>
        value is string s && !System.Text.RegularExpressions.Regex.IsMatch(s, pattern) ? new ValidationResult(hint) : ValidationResult.Success;
}
