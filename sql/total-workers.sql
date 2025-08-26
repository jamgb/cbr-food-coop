select 
    count(distinct(member)) AS total_volunteers
from members_history 
where datenew > now() - interval '1 year' and action = 'Volunteered';