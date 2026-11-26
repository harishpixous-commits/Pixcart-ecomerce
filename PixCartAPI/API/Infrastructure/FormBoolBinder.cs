using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace API.Infrastructure;

/// <summary>
/// Binds <c>bool</c> and <c>bool?</c> query, route and form values in the words the public API accepts (1/0, on/off,
/// t/f, true/false, y/n, yes/no, in any case), the same set <see cref="QueryRulesFilter"/> validates. The last value of
/// a repeated parameter wins. ASP.NET's default binder only understands true/false.
/// </summary>
public sealed class FormBoolBinderProvider : IModelBinderProvider
{
    public IModelBinder? GetBinder(ModelBinderProviderContext context) =>
        context.Metadata.UnderlyingOrModelType == typeof(bool) && context.BindingInfo.BindingSource?.IsFromRequest != false
            ? new FormBoolBinder()
            : null;
}

public sealed class FormBoolBinder : IModelBinder
{
    public Task BindModelAsync(ModelBindingContext context)
    {
        var result = context.ValueProvider.GetValue(context.ModelName);
        if (result == ValueProviderResult.None) return Task.CompletedTask; // absent: the parameter keeps its default
        context.ModelState.SetModelValue(context.ModelName, result);
        var word = (result.Values.Count > 0 ? result.Values[^1] : null)?.Trim().ToLowerInvariant() ?? "";
        if (QueryRulesFilter.TrueWords.Contains(word)) context.Result = ModelBindingResult.Success(true);
        else if (QueryRulesFilter.FalseWords.Contains(word)) context.Result = ModelBindingResult.Success(false);
        else context.ModelState.TryAddModelError(context.ModelName, "must be on or off");
        return Task.CompletedTask;
    }
}
