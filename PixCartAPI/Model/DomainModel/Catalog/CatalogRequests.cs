using System.ComponentModel.DataAnnotations;

namespace Model.DomainModel.Catalog;

// Request bodies of the storefront and catalogue (same names and limits as the reference API).

/// <summary>POST /api/catalog/products/{slug}/questions</summary>
public class QuestionIn
{
    [Required(ErrorMessage = "is required"), Len(10, 500)]
    public string Text { get; set; } = null!;
}

/// <summary>POST /api/questions/{id}/answers and /api/seller/questions/{id}/answer</summary>
public class AnswerIn
{
    [Required(ErrorMessage = "is required"), Len(2, 1000)]
    public string Text { get; set; } = null!;
}

/// <summary>POST /api/qa/report</summary>
public class QaReportIn
{
    [Required(ErrorMessage = "is required"), OneOf("question", "answer")]
    public string Kind { get; set; } = null!;

    [Required(ErrorMessage = "is required")]
    public Guid? Id { get; set; }
}

/// <summary>POST /api/alerts/stock</summary>
public class AlertIn
{
    [Required(ErrorMessage = "is required")]
    public Guid? VariantId { get; set; }
}

/// <summary>POST /api/i18n/translate (at most 80 lines per request).</summary>
public class TranslateIn
{
    [Required(ErrorMessage = "is required"), Len(2, 12)]
    public string Lang { get; set; } = null!;

    [Required(ErrorMessage = "is required"), Count(80)]
    public List<string> Texts { get; set; } = null!;
}

/// <summary>PUT /api/admin/translations: a staff correction.</summary>
public class TranslationIn
{
    [Required(ErrorMessage = "is required"), Len(2, 12)]
    public string Lang { get; set; } = null!;

    [Required(ErrorMessage = "is required"), Len(1, 400)]
    public string Source { get; set; } = null!;

    [Required(ErrorMessage = "is required"), Len(1, 1200)]
    public string Text { get; set; } = null!;
}

/// <summary>A photo or video in a review (the address is checked by the review rules: uploads only).</summary>
public class ReviewMediaIn
{
    [Required(ErrorMessage = "is required"), OneOf("image", "video")]
    public string Kind { get; set; } = null!;

    [Required(ErrorMessage = "is required"), Len(0, 400)]
    public string Url { get; set; } = null!;

    [Len(0, 400)]
    public string PosterUrl { get; set; } = "";
}

/// <summary>PUT /api/catalog/products/{slug}/reviews</summary>
public class ReviewIn
{
    [Required(ErrorMessage = "is required"), Between(1, 5)]
    public int? Rating { get; set; }

    [Len(0, 120)]
    public string Title { get; set; } = "";

    [Len(0, 4000)]
    public string Body { get; set; } = "";

    [Count(12)]
    public List<ReviewMediaIn> Media { get; set; } = [];
}

/// <summary>POST /api/reviews/{id}/report</summary>
public class ReviewReportIn
{
    [Required(ErrorMessage = "is required"), Len(0, 20)]
    public string Reason { get; set; } = null!;

    [Len(0, 500)]
    public string Note { get; set; } = "";
}

/// <summary>POST /api/catalog/products/{slug}/report</summary>
public class ProductReportIn
{
    [Required(ErrorMessage = "is required"), Len(0, 20)]
    public string Reason { get; set; } = null!;

    [Len(0, 2000)]
    public string Note { get; set; } = "";

    [Len(0, 400)]
    public string Url { get; set; } = "";
}
