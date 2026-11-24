using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>Home page sections and CMS pages (Admin → Storefront).</summary>
public class CmsDAL(IMySqlDapperHelper db)
{
    public async Task<bool> AnySectionAsync() =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM (SELECT id FROM home_sections LIMIT 1) x") > 0;

    public Task InsertSectionAsync(HomeSectionModel s) =>
        db.ExecuteAsync(
            "INSERT INTO home_sections (id, kind, title, config, position, is_active, device, starts_at, ends_at, created_at, updated_at) " +
            "VALUES (@Id, @Kind, @Title, CAST(@Config AS JSON), @Position, @IsActive, @Device, @StartsAt, @EndsAt, @CreatedAt, @UpdatedAt)", s);

    /// <summary>All sections in page order (the admin list).</summary>
    public Task<IEnumerable<HomeSectionModel>> AllSectionsAsync() =>
        db.QueryAsync<HomeSectionModel>("SELECT * FROM home_sections ORDER BY position, created_at");

    /// <summary>Switched-on sections whose schedule includes now, in page order.</summary>
    public Task<IEnumerable<HomeSectionModel>> LiveSectionsAsync(DateTime now) =>
        db.QueryAsync<HomeSectionModel>(
            "SELECT * FROM home_sections WHERE is_active = 1 AND (starts_at IS NULL OR starts_at <= @now) AND (ends_at IS NULL OR ends_at >= @now) " +
            "ORDER BY position, created_at", new { now });

    public Task<HomeSectionModel?> GetSectionAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<HomeSectionModel>("SELECT * FROM home_sections WHERE id = @id", new { id });

    public Task UpdateSectionAsync(HomeSectionModel s) =>
        db.ExecuteAsync(
            "UPDATE home_sections SET title = @Title, config = CAST(@Config AS JSON), is_active = @IsActive, device = @Device, " +
            "starts_at = @StartsAt, ends_at = @EndsAt, position = @Position, updated_at = @UpdatedAt WHERE id = @Id", s);

    public Task<int> DeleteSectionAsync(Guid id) => db.ExecuteAsync("DELETE FROM home_sections WHERE id = @id", new { id });

    public async Task<int> MaxPositionAsync() => await db.ExecuteScalarAsync<int?>("SELECT MAX(position) FROM home_sections") ?? 0;

    public Task<CmsPageModel?> GetPageAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<CmsPageModel>("SELECT * FROM cms_pages WHERE slug = @slug", new { slug });

    public Task<IEnumerable<CmsPageModel>> AllPagesAsync() =>
        db.QueryAsync<CmsPageModel>("SELECT * FROM cms_pages ORDER BY slug");

    public Task UpsertPageAsync(CmsPageModel p) =>
        db.ExecuteAsync(
            "INSERT INTO cms_pages (id, slug, title, body, meta_description, is_published, created_at, updated_at) " +
            "VALUES (@Id, @Slug, @Title, @Body, @MetaDescription, @IsPublished, @CreatedAt, @UpdatedAt) " +
            "ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), meta_description = VALUES(meta_description), " +
            "is_published = VALUES(is_published), updated_at = VALUES(updated_at)", p);

    public static DateTime Now() => DateTimeFunctions.UtcNow();
}
