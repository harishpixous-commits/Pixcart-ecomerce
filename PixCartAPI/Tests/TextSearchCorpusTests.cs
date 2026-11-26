using System.Text.Json;
using Utils.TextSearch;
using Xunit.Abstractions;

namespace Tests;

/// <summary>
/// The text search engine against a randomized corpus of expected results (Fixtures/text-search-cases.json): texts
/// with every kind of token, product documents with overlapping prefixes and repeated words under every-word and
/// any-word prefix queries, typo searches against titles, and lists with many equal counts for the result sort.
/// </summary>
public class TextSearchCorpusTests(ITestOutputHelper output)
{
    private static readonly JsonElement Cases =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "text-search-cases.json"))).RootElement;

    private static List<string> Differences(string section)
    {
        var outp = new List<string>();
        foreach (var c in Cases.GetProperty(section).EnumerateArray())
        {
            var text = c.GetProperty("text").GetString()!;
            var expected = c.GetProperty("vector").GetString();
            var actual = SearchVector.FromText(text).ToString();
            if (actual != expected) outp.Add($"{JsonSerializer.Serialize(text)}\n  expected: {expected}\n  actual:   {actual}");
        }
        return outp;
    }

    [Fact]
    public void Tokens_and_vectors_are_the_expected_ones_for_every_ascii_text()
    {
        var differences = Differences("parser");
        Assert.True(differences.Count == 0, $"{differences.Count} text(s) differ:\n" + string.Join("\n", differences.Take(40)));
    }

    [Fact]
    public void Tokens_and_vectors_are_the_expected_ones_for_non_ascii_texts()
    {
        // accented words, Hindi with its vowel signs, the rupee sign, degrees, dashes and symbols
        var differences = Differences("parser_non_ascii");
        foreach (var d in differences.Take(30)) output.WriteLine(d);
        Assert.True(differences.Count == 0, $"{differences.Count} non-ASCII text(s) differ:\n" + string.Join("\n", differences.Take(30)));
    }

    [Fact]
    public void Matches_and_ranks_are_the_expected_ones_for_every_word_and_any_word_queries()
    {
        var docs = Cases.GetProperty("ranking").GetProperty("documents").EnumerateArray()
            .Select(d => SearchDocument.Build(d.GetProperty("title").GetString(), d.GetProperty("brand").GetString(), d.GetProperty("description").GetString()))
            .ToArray();
        var failures = new List<string>();
        var compared = 0;
        foreach (var q in Cases.GetProperty("ranking").GetProperty("queries").EnumerateArray())
        {
            var words = q.GetProperty("words").EnumerateArray().Select(w => w.GetString()!);
            var query = SearchQuery.Prefix(ShopperWords.Split(string.Join(" ", words), ProductTextQuery.MaxWords), q.GetProperty("any").GetBoolean());
            foreach (var r in q.GetProperty("results").EnumerateArray())
            {
                var doc = docs[r[0].GetInt32()];
                compared++;
                var match = query.Matches(doc.Vector);
                var rank = (double)query.Rank(doc.Vector);
                if (match != r[1].GetBoolean() || rank != r[2].GetDouble())
                    failures.Add($"{q.GetProperty("terms").GetString()} on doc {r[0]}: {match}/{rank:R}, expected {r[1].GetBoolean()}/{r[2].GetDouble():R}");
            }
        }
        Assert.True(compared > 5000, $"only {compared} comparisons");
        Assert.True(failures.Count == 0, $"{failures.Count} of {compared} differ:\n" + string.Join("\n", failures.Take(40)));
    }

    [Fact]
    public void Equal_counts_come_out_in_the_expected_order()
    {
        var failures = new List<string>();
        var cases = 0;
        foreach (var c in Cases.GetProperty("sort").EnumerateArray())
        {
            var counts = c.GetProperty("counts").EnumerateArray().Select(x => x.GetInt32()).ToArray();
            int? limit = c.GetProperty("limit").ValueKind == JsonValueKind.Null ? null : c.GetProperty("limit").GetInt32();
            var expected = c.GetProperty("order").EnumerateArray().Select(x => x.GetInt32()).ToArray();
            var actual = ResultSort.Order(Enumerable.Range(0, counts.Length), (x, y) => counts[y].CompareTo(counts[x]), limit).ToArray();
            cases++;
            if (!actual.SequenceEqual(expected))
                failures.Add($"{counts.Length} rows, limit {limit?.ToString() ?? "none"}:\n  expected {string.Join(",", expected)}\n  actual   {string.Join(",", actual)}");
        }
        Assert.True(cases >= 200, $"only {cases} cases");
        Assert.True(failures.Count == 0, $"{failures.Count} of {cases} differ:\n" + string.Join("\n", failures.Take(10)));
    }

    [Fact]
    public void Word_similarities_are_the_expected_ones()
    {
        var failures = new List<string>();
        foreach (var c in Cases.GetProperty("similarity").EnumerateArray())
        {
            var search = c.GetProperty("search").GetString()!;
            var title = c.GetProperty("title").GetString()!;
            var actual = (double)new TrigramQuery(search).WordSimilarity(title);
            var expected = c.GetProperty("word_similarity").GetDouble();
            if (actual != expected) failures.Add($"word similarity of \"{search}\" to \"{title}\": {actual:R}, expected {expected:R}");
        }
        Assert.True(failures.Count == 0, $"{failures.Count} differ:\n" + string.Join("\n", failures.Take(40)));
    }
}
