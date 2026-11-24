using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class CmsAdminDAL(IMySqlDapperHelper db)
{
    public Task SavePageAsync(CmsPageModel p,bool exists,IUnitOfWork tx)=>exists?tx.ExecuteAsync("UPDATE cms_pages SET slug=@Slug,title=@Title,body=@Body,meta_description=@MetaDescription,is_published=@IsPublished,updated_at=UTC_TIMESTAMP(6) WHERE id=@Id",p):tx.ExecuteAsync("INSERT INTO cms_pages(id,slug,title,body,meta_description,is_published,created_at,updated_at)VALUES(@Id,@Slug,@Title,@Body,@MetaDescription,@IsPublished,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",p);
    public Task DeletePageAsync(string slug,IUnitOfWork tx)=>tx.ExecuteAsync("DELETE FROM cms_pages WHERE slug=@slug",new{slug});
}
