namespace Utils.TextSearch;

/// <summary>
/// What the storefront search knows about one product: its search vector (title and brand with weight A, description
/// with weight C), the title's trigrams and the brand.
/// </summary>
public sealed class SearchDocument
{
    private SearchDocument(string title, string brand, SearchVector vector, TrigramSequence titleTrigrams)
    {
        Title = title;
        Brand = brand;
        Vector = vector;
        TitleTrigrams = titleTrigrams;
    }

    public string Title { get; }
    public string Brand { get; }
    public SearchVector Vector { get; }
    public TrigramSequence TitleTrigrams { get; }

    /// <summary>The vector of the title and brand (weight A) followed by the description (weight C), and the title's trigrams.</summary>
    public static SearchDocument Build(string? title, string? brand, string? description)
    {
        title ??= "";
        brand ??= "";
        var vector = SearchVector.Concat(
            SearchVector.Concat(SearchVector.FromText(title, SearchWeight.A), SearchVector.FromText(brand, SearchWeight.A)),
            SearchVector.FromText(description ?? "", SearchWeight.C));
        return new SearchDocument(title, brand, vector, TrigramSequence.Of(title));
    }
}

/// <summary>
/// The storefront's text search. For the trimmed search text:
/// <list type="bullet">
/// <item>words: lower case, split at non-word characters, at most <see cref="MaxWords"/>;</item>
/// <item>a product matches when its vector has every word as a prefix of one of its lexemes, or the text is close to
/// the title (trigram word similarity at least <see cref="TypoThreshold"/>), or the brand matches the text as an ILIKE
/// pattern;</item>
/// <item>its relevance is the query's rank plus the word similarity, in single precision.</item>
/// </list>
/// Search suggestions use the first two conditions and order by the word similarity.
/// </summary>
public sealed class ProductTextQuery
{
    /// <summary>Words of a search that count (the rest are ignored).</summary>
    public const int MaxWords = 8;

    /// <summary>
    /// The least trigram word similarity of a typo-tolerant title match: looser than the customary 0.6, so a one-letter
    /// typo still finds the product.
    /// </summary>
    public const double TypoThreshold = 0.45;

    private readonly TrigramQuery trigrams;

    private ProductTextQuery(string text, SearchQuery query, double threshold)
    {
        Text = text;
        Query = query;
        Threshold = threshold;
        trigrams = new TrigramQuery(text);
    }

    public string Text { get; }
    public SearchQuery Query { get; }
    public double Threshold { get; }

    /// <summary>The query for an already trimmed, non-empty search text.</summary>
    public static ProductTextQuery For(string text, double threshold = TypoThreshold) =>
        new(text, SearchQuery.Prefix(ShopperWords.Split(text, MaxWords)), threshold);

    /// <summary>Whether the product is a search result, and its relevance.</summary>
    public bool Matches(SearchDocument doc, out float relevance)
    {
        var similarity = trigrams.WordSimilarity(doc.TitleTrigrams);
        var match = Query.Matches(doc.Vector) || similarity >= Threshold || SqlLike.ILike(doc.Brand, Text);
        relevance = Query.IsEmpty ? similarity : (float)(Query.Rank(doc.Vector) + similarity); // single precision
        return match;
    }

    /// <summary>Whether the product is a suggestion (its words or a close title, not the brand), and its word similarity.</summary>
    public bool Suggests(SearchDocument doc, out float similarity)
    {
        similarity = trigrams.WordSimilarity(doc.TitleTrigrams);
        return similarity >= Threshold || Query.Matches(doc.Vector);
    }

    /// <summary>
    /// An integer that orders like the relevance: for the non-negative floats a relevance can be, the bit pattern grows
    /// with the value, so the database orders exactly as the floats do without parsing decimal numbers.
    /// </summary>
    public static int OrderKey(float relevance) => BitConverter.SingleToInt32Bits(relevance <= 0 ? 0f : relevance);
}
