using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.Catalog;

namespace API.Controllers;

/// <summary>
/// Languages, currencies, regions and payment options; the site's translations; shoppers' saved cards.
/// Public: GET /api/regional, POST /api/i18n/translate. Shopper: GET/DELETE /api/account/cards.
/// Admin: GET/PUT /api/admin/regional, POST /api/admin/regional/rates, translations list/edit/delete.
/// </summary>
[ApiController]
public class RegionalController(IRegionalBAL regional, ITranslateBAL translate, ICurrentUser me) : ControllerBase
{
    /// <summary>The shop's currencies, languages and the suggestion for the visitor's country. Without a country in the
    /// query, the country the hosting edge reports (Cloudflare or Vercel) is used; nothing is asked or stored.</summary>
    [HttpGet("/api/regional")]
    public Task<JsonObject> Public([FromQuery, Len(0, 2)] string country = "") =>
        regional.PublicAsync(country.Length > 0 ? country : EdgeCountry());

    /// <summary>The visitor's country from the edge's header, when it is a real two-letter code ("XX" means unknown and
    /// "T1" Tor at Cloudflare; anything else that is not a country code is ignored).</summary>
    private string EdgeCountry()
    {
        foreach (var header in new[] { "CF-IPCountry", "X-Vercel-IP-Country" })
        {
            var value = Request.Headers[header].ToString().Trim().ToUpperInvariant();
            if (value.Length == 2 && char.IsAsciiLetterUpper(value[0]) && char.IsAsciiLetterUpper(value[1]) && value is not ("XX" or "T1"))
                return value;
        }
        return "";
    }

    /// <summary>The words on a page in the visitor's language. Lines nobody has translated yet come back missing (English).</summary>
    [HttpPost("/api/i18n/translate")]
    public Task<JsonObject> Translate([FromBody] TranslateIn body) => translate.TranslateTextsAsync(body.Lang, body.Texts, me.IpAddress);

    [HttpGet("/api/account/cards"), SignedIn]
    public async Task<JsonObject> MyCards() => await regional.MyCardsAsync(await me.RequireAsync());

    [HttpDelete("/api/account/cards/{tokenId}"), SignedIn]
    public async Task<JsonObject> RemoveCard(string tokenId) => await regional.RemoveCardAsync(await me.RequireAsync(), tokenId);

    [HttpGet("/api/admin/regional"), Perm("settings")]
    public Task<JsonObject> Admin() => regional.AdminViewAsync();

    [HttpPut("/api/admin/regional"), Perm("settings")]
    public async Task<JsonObject> Save([FromBody] JsonObject body) => await regional.SaveAsync(await me.RequireAsync(), body);

    [HttpPost("/api/admin/regional/rates"), Perm("settings")]
    public async Task<JsonObject> RefreshRates() => await regional.RefreshRatesNowAsync(await me.RequireAsync());

    [HttpGet("/api/admin/translations"), Perm("settings")]
    public Task<JsonObject> ListTranslations([FromQuery, Required(ErrorMessage = "is required"), Len(0, 12)] string lang,
        [FromQuery, Len(0, 100)] string q = "", [FromQuery, Pattern("^(|ai|manual)$")] string origin = "",
        [FromQuery, Between(1, 10000)] int page = 1) =>
        translate.ListAsync(lang, q, origin, page);

    /// <summary>A staff correction: kept for good, never replaced by the AI.</summary>
    [HttpPut("/api/admin/translations"), Perm("settings")]
    public async Task<JsonObject> SaveTranslation([FromBody] TranslationIn body) =>
        await translate.SaveCorrectionAsync(await me.RequireAsync(), body.Lang, body.Source, body.Text);

    /// <summary>Removes one line, or every AI line of a language (to translate again, e.g. after switching to a better model).</summary>
    [HttpDelete("/api/admin/translations"), Perm("settings")]
    public async Task<JsonObject> ClearTranslations([FromQuery, Required(ErrorMessage = "is required"), Len(0, 12)] string lang,
        [FromQuery, Len(0, 40)] string id = "", [FromQuery(Name = "only_ai")] bool onlyAi = true) =>
        await translate.ClearAsync(await me.RequireAsync(), lang, id, onlyAi);
}
