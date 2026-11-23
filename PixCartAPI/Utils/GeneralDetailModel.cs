namespace Utils;

/// <summary>A page of results, as every list endpoint returns it: {"items": [...], "total": n, "page": p, "page_size": s}.</summary>
public class PagedResult<T>
{
    public IEnumerable<T> Items { get; set; } = [];
    public long Total { get; set; }
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;
}

/// <summary>Paging input with safe bounds.</summary>
public record Paging(int Page = 1, int PageSize = 20)
{
    public int SafePage => Math.Max(1, Page);
    public int SafeSize => Math.Clamp(PageSize, 1, 200);
    public int Offset => (SafePage - 1) * SafeSize;
}
