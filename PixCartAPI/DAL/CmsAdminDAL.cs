using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class CmsAdminDAL
{
    public Task SavePageAsync(CmsPageModel p,bool exists,IUnitOfWork tx)=>exists?tx.ExecuteAsync("UPDATE cms_pages SET slug=@Slug,title=@Title,body=@Body,meta_description=@MetaDescription,is_published=@IsPublished,updated_at=UTC_TIMESTAMP(6) WHERE id=@Id",p):tx.ExecuteAsync("INSERT INTO cms_pages(id,slug,title,body,meta_description,is_published,created_at,updated_at)VALUES(@Id,@Slug,@Title,@Body,@MetaDescription,@IsPublished,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",p);
    public Task DeletePageAsync(string slug,IUnitOfWork tx)=>tx.ExecuteAsync("DELETE FROM cms_pages WHERE slug=@slug",new{slug});

    public Task<IEnumerable<HomeSectionModel>> SectionsAsync(IUnitOfWork tx)=>tx.QueryAsync<HomeSectionModel>("SELECT * FROM home_sections ORDER BY position,created_at");
    public Task InsertSectionAsync(HomeSectionModel s,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO home_sections(id,kind,title,config,position,is_active,device,starts_at,ends_at,created_at,updated_at)VALUES(@Id,@Kind,@Title,CAST(@Config AS JSON),@Position,@IsActive,@Device,@StartsAt,@EndsAt,@CreatedAt,@UpdatedAt)",s);
    public Task UpdateSectionAsync(HomeSectionModel s,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE home_sections SET title=@Title,config=CAST(@Config AS JSON),is_active=@IsActive,device=@Device,starts_at=@StartsAt,ends_at=@EndsAt,updated_at=UTC_TIMESTAMP(6) WHERE id=@Id",s);
    public Task DeleteSectionAsync(Guid id,IUnitOfWork tx)=>tx.ExecuteAsync("DELETE FROM home_sections WHERE id=@id",new{id});
    public Task PositionAsync(Guid id,int position,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE home_sections SET position=@position,updated_at=UTC_TIMESTAMP(6) WHERE id=@id",new{id,position});
}
