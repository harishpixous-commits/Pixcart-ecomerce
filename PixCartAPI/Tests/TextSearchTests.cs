using System.Text.Json;
using Utils.TextSearch;

namespace Tests;

/// <summary>
/// The storefront text search against expected results. Fixtures/search-ranking.json holds, for the seeded demo products
/// and for synthetic texts with the hard cases (decimals, units, hyphens, apostrophes, paths, e-mail, hosts), the
/// expected search vector and, for 52 searches, whether each product matches, its rank and the trigram word similarity
/// of the search to its title. Every value is reproduced exactly, to the last bit of the float.
/// </summary>
public class TextSearchTests
{
    private static readonly JsonElement Fixture =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "search-ranking.json"))).RootElement;

    private static Dictionary<string, SearchDocument> Documents() =>
        Fixture.GetProperty("products").EnumerateArray().ToDictionary(
            p => p.GetProperty("id").GetString()!,
            p => SearchDocument.Build(p.GetProperty("title").GetString(), p.GetProperty("brand").GetString(), p.GetProperty("description").GetString()));

    [Fact]
    public void Search_vectors_are_the_expected_ones()
    {
        var docs = Documents();
        var failures = new List<string>();
        foreach (var p in Fixture.GetProperty("products").EnumerateArray())
        {
            var id = p.GetProperty("id").GetString()!;
            var expected = p.GetProperty("vector").GetString();
            var actual = docs[id].Vector.ToString();
            if (actual != expected) failures.Add($"{id} \"{p.GetProperty("title").GetString()}\"\n  expected: {expected}\n  actual:   {actual}");
        }
        Assert.True(failures.Count == 0, $"{failures.Count} vector(s) differ:\n" + string.Join("\n", failures));
    }

    [Fact]
    public void Matches_ranks_and_similarities_are_the_expected_ones()
    {
        var docs = Documents();
        var failures = new List<string>();
        var compared = 0;
        foreach (var search in Fixture.GetProperty("searches").EnumerateArray())
        {
            var text = search.GetProperty("query").GetString()!;
            var query = SearchQuery.Prefix(ShopperWords.Split(text, ProductTextQuery.MaxWords));
            var trigrams = new TrigramQuery(text);
            foreach (var row in search.GetProperty("products").EnumerateObject())
            {
                var doc = docs[row.Name];
                var want = row.Value;
                var match = query.Matches(doc.Vector);
                var rank = (double)query.Rank(doc.Vector);
                var similarity = (double)trigrams.WordSimilarity(doc.TitleTrigrams);
                compared++;
                if (match != want.GetProperty("match").GetBoolean()) failures.Add($"\"{text}\" / {row.Name}: match {match}, expected {want.GetProperty("match").GetBoolean()}");
                if (rank != want.GetProperty("rank").GetDouble()) failures.Add($"\"{text}\" / {row.Name}: rank {rank:R}, expected {want.GetProperty("rank").GetDouble():R}");
                if (similarity != want.GetProperty("word_similarity").GetDouble())
                    failures.Add($"\"{text}\" / {row.Name}: word similarity {similarity:R}, expected {want.GetProperty("word_similarity").GetDouble():R}");
                // the fixture's typo flag uses the customary threshold, 0.6
                if (similarity >= 0.6 != want.GetProperty("fuzzy").GetBoolean()) failures.Add($"\"{text}\" / {row.Name}: typo flag differs");
            }
        }
        Assert.True(compared > 1500, $"only {compared} comparisons");
        Assert.True(failures.Count == 0, $"{failures.Count} of {compared} differ:\n" + string.Join("\n", failures.Take(60)));
    }

    [Fact]
    public void Parser_reads_a_number_with_a_unit_as_number_and_word()
    {
        var tokens = TextTokenizer.Tokenize("22.5W Fast Charge").Where(t => SearchVector.IsIndexed(t.Type)).Select(t => $"{t.Type}:{t.Text}");
        Assert.Equal(new[] { "Float:22.5", "AsciiWord:W", "AsciiWord:Fast", "AsciiWord:Charge" }, tokens);
    }

    [Theory]
    [InlineData("Men's Shirt", new[] { "men", "s", "shirt" })]
    [InlineData("USB-C cable", new[] { "usb-c", "usb", "c", "cable" })]
    [InlineData("3-in-1 pack", new[] { "3", "in", "-1", "pack" })]
    [InlineData("5,000mAh", new[] { "5", "000mah" })]
    [InlineData("18/8 steel", new[] { "18/8", "steel" })]
    [InlineData("e.g. this", new[] { "e.g", "this" })]
    [InlineData("<b>Bold</b> &amp; free", new[] { "bold", "free" })]
    public void Lexemes_follow_the_tokenizer_rules(string text, string[] expected) =>
        Assert.Equal(expected, SearchVector.Lexemes(text));

    [Theory]
    [InlineData("Levi's", "levi%", true)]
    [InlineData("Levi's", "LEVI'S", true)]
    [InlineData("Tamra", "t_mra", true)]
    [InlineData("Tamra", "tam", false)]
    [InlineData("100%", "100\\%", true)]
    [InlineData("Tamra", "tamra\\", false)]
    [InlineData("", "%", true)]
    public void Brand_patterns_follow_ilike(string brand, string pattern, bool expected) =>
        Assert.Equal(expected, SqlLike.ILike(brand, pattern));

    [Fact]
    public void Words_split_like_the_storefront()
    {
        Assert.Equal(new[] { "men", "s", "cotton" }, ShopperWords.Split("  Men's   COTTON!! "));
        Assert.Equal(new[] { "t_shirt", "22", "5w" }, ShopperWords.Split("T_shirt 22.5W"));
        Assert.Equal(8, ShopperWords.Split("a b c d e f g h i j", ProductTextQuery.MaxWords).Count);
    }

    [Fact]
    public void A_word_the_parser_splits_becomes_a_phrase()
    {
        var query = SearchQuery.Prefix(["t_shirt"]);
        Assert.Equal("'t':* <-> 'shirt':*", query.ToString());
        Assert.True(query.Matches(SearchDocument.Build("Kids T Shirt", "", "").Vector));
        Assert.False(query.Matches(SearchDocument.Build("Shirt for T", "", "").Vector));
    }

    [Fact]
    public void Relevance_order_keys_order_like_the_floats()
    {
        float[] values = [0f, 1e-20f, 0.12158f, 0.5f, 0.607927f, 0.638323f, 0.845778f, 1f, 1.5f, 7.25f];
        var keys = values.Select(ProductTextQuery.OrderKey).ToArray();
        Assert.Equal(keys.OrderBy(k => k), keys);
        Assert.Equal(keys.Length, keys.Distinct().Count());
    }

    [Fact]
    public void Typo_threshold_lets_a_one_letter_typo_through()
    {
        // "cotan" against "Pure Cotton Shirt": a one-letter typo is within 0.45 but not the customary 0.6
        var q = ProductTextQuery.For("cotan");
        var doc = SearchDocument.Build("Pure Cotton Shirt", "", "");
        var similarity = new TrigramQuery("cotan").WordSimilarity(doc.TitleTrigrams);
        Assert.InRange(similarity, 0.45f, 0.6f);
        Assert.True(q.Matches(doc, out _));
    }
}
