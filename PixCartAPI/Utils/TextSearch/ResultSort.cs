using System.Globalization;

namespace Utils.TextSearch;

/// <summary>
/// The sort for result lists ordered by one key, such as facets by count: a three-way quicksort (insertion sort below
/// 7 rows, a presorted check, median-of-three pivots and a ninther above 40 rows) or, when a limit applies and the input
/// exceeds twice the limit, a bounded heap. Neither keeps equal rows in input order, but both are deterministic: the
/// same rows in the same order always come out the same way, so the lists are stable from one request to the next.
/// </summary>
public static class ResultSort
{
    /// <summary>The rows ordered by <paramref name="compare"/>, at most <paramref name="limit"/>.</summary>
    public static List<T> Order<T>(IEnumerable<T> input, Comparison<T> compare, int? limit = null)
    {
        var rows = new List<T>();
        if (limit is not { } bound)
        {
            rows.AddRange(input);
            QuickSort(rows, 0, rows.Count, compare);
            return rows;
        }
        if (bound <= 0) return rows;

        // the reversed order keeps the row that sorts last at the top of the heap
        Comparison<T> reversed = (a, b) => -compare(a, b);
        var heap = false;
        foreach (var row in input)
        {
            if (!heap)
            {
                rows.Add(row);
                if (rows.Count > bound * 2)
                {
                    var all = rows.ToArray();
                    rows.Clear();
                    foreach (var r in all) PushBounded(rows, r, bound, reversed);
                    heap = true;
                }
            }
            else PushBounded(rows, row, bound, reversed);
        }
        if (!heap)
        {
            QuickSort(rows, 0, rows.Count, compare);
            return rows.Count > bound ? rows.GetRange(0, bound) : rows;
        }
        // unwind the heap: take the top (the row that sorts last) and store it in the slot freed at the end
        for (var n = rows.Count; n > 1;)
        {
            var top = rows[0];
            n--;
            ReplaceTop(rows, rows[n], n, reversed);
            rows[n] = top;
        }
        return rows;
    }

    private static void PushBounded<T>(List<T> heap, T row, int bound, Comparison<T> reversed)
    {
        if (heap.Count < bound)
        {
            // sift up
            heap.Add(row);
            var j = heap.Count - 1;
            while (j > 0)
            {
                var i = (j - 1) >> 1;
                if (reversed(row, heap[i]) >= 0) break;
                heap[j] = heap[i];
                j = i;
            }
            heap[j] = row;
        }
        else if (reversed(row, heap[0]) > 0) ReplaceTop(heap, row, heap.Count, reversed);
        // else: the new row would sort after everything kept, so it is dropped
    }

    /// <summary>Replaces the top of the heap held in the first <paramref name="n"/> slots and sifts it down.</summary>
    private static void ReplaceTop<T>(List<T> heap, T row, int n, Comparison<T> reversed)
    {
        var i = 0;
        for (;;)
        {
            var j = 2 * i + 1;
            if (j >= n) break;
            if (j + 1 < n && reversed(heap[j], heap[j + 1]) > 0) j++;
            if (reversed(row, heap[j]) <= 0) break;
            heap[i] = heap[j];
            i = j;
        }
        heap[i] = row;
    }

    /// <summary>The quicksort over rows[a, a + n).</summary>
    private static void QuickSort<T>(List<T> rows, int a, int n, Comparison<T> cmp)
    {
        while (true)
        {
            if (n < 7)
            {
                for (var pm = a + 1; pm < a + n; pm++)
                    for (var pl = pm; pl > a && cmp(rows[pl - 1], rows[pl]) > 0; pl--)
                        Swap(rows, pl, pl - 1);
                return;
            }
            var presorted = true;
            for (var pm = a + 1; pm < a + n; pm++)
                if (cmp(rows[pm - 1], rows[pm]) > 0)
                {
                    presorted = false;
                    break;
                }
            if (presorted) return;

            var mid = a + n / 2;
            if (n > 7)
            {
                var pl = a;
                var pn = a + n - 1;
                if (n > 40)
                {
                    var d = n / 8;
                    pl = Med3(rows, pl, pl + d, pl + 2 * d, cmp);
                    mid = Med3(rows, mid - d, mid, mid + d, cmp);
                    pn = Med3(rows, pn - 2 * d, pn - d, pn, cmp);
                }
                mid = Med3(rows, pl, mid, pn, cmp);
            }
            Swap(rows, a, mid);
            int pa = a + 1, pb = pa, pc = a + n - 1, pd = pc;
            for (;;)
            {
                int r;
                while (pb <= pc && (r = cmp(rows[pb], rows[a])) <= 0)
                {
                    if (r == 0) Swap(rows, pa++, pb);
                    pb++;
                }
                while (pb <= pc && (r = cmp(rows[pc], rows[a])) >= 0)
                {
                    if (r == 0) Swap(rows, pc, pd--);
                    pc--;
                }
                if (pb > pc) break;
                Swap(rows, pb++, pc--);
            }
            var end = a + n;
            var d1 = Math.Min(pa - a, pb - pa);
            SwapN(rows, a, pb - d1, d1);
            d1 = Math.Min(pd - pc, end - pd - 1);
            SwapN(rows, pb, end - d1, d1);
            d1 = pb - pa;
            var d2 = pd - pc;
            if (d1 <= d2)
            {
                if (d1 > 1) QuickSort(rows, a, d1, cmp);
                if (d2 <= 1) return;
                a = end - d2;
                n = d2;
            }
            else
            {
                if (d2 > 1) QuickSort(rows, end - d2, d2, cmp);
                if (d1 <= 1) return;
                n = d1;
            }
        }
    }

    private static int Med3<T>(List<T> rows, int a, int b, int c, Comparison<T> cmp) =>
        cmp(rows[a], rows[b]) < 0
            ? cmp(rows[b], rows[c]) < 0 ? b : cmp(rows[a], rows[c]) < 0 ? c : a
            : cmp(rows[b], rows[c]) > 0 ? b : cmp(rows[a], rows[c]) < 0 ? a : c;

    private static void Swap<T>(List<T> rows, int i, int j) => (rows[i], rows[j]) = (rows[j], rows[i]);

    private static void SwapN<T>(List<T> rows, int i, int j, int n)
    {
        for (var k = 0; k < n; k++) Swap(rows, i + k, j + k);
    }
}

/// <summary>
/// Linguistic text order: the culture-invariant comparison, and for strings it calls equal although they differ (for
/// example only in case), their UTF-8 byte order, so the order is total.
/// </summary>
public sealed class TextCollation : IComparer<string>
{
    public static readonly TextCollation Instance = new();

    private static readonly CompareInfo Info = CultureInfo.InvariantCulture.CompareInfo;

    public int Compare(string? x, string? y)
    {
        if (ReferenceEquals(x, y)) return 0;
        if (x is null) return -1;
        if (y is null) return 1;
        var c = Info.Compare(x, y, CompareOptions.None);
        return c != 0 ? c : ByteOrder(x, y);
    }

    /// <summary>UTF-8 byte order (code-point order) of two strings.</summary>
    public static int ByteOrder(string a, string b)
    {
        var n = Math.Min(a.Length, b.Length);
        for (var i = 0; i < n; i++)
        {
            int x = a[i], y = b[i];
            if (x != y) return Fix(x) - Fix(y);
        }
        return a.Length - b.Length;

        static int Fix(int c) => c >= 0xE000 ? c - 0x800 : c >= 0xD800 ? c + 0x2000 : c;
    }
}
