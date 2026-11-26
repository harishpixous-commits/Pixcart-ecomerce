namespace Model.DomainModel;

/// <summary>Hand-written additions to the generated row class.</summary>
public partial class UserModel
{
    /// <summary>A copy, to tell afterwards which fields an action changed.</summary>
    public UserModel Copy() => (UserModel)MemberwiseClone();
}
